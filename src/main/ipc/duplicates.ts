import { ipcMain } from 'electron';
import { runtime, safeConsole, sendToWindow } from '../runtime';
import { substitutePlaylistTrackIds } from '../playlistSubstitution';
import { computeDeletablePaths } from '../safeDeletePaths';
import { mergeDuplicateEntries, type MergePlan } from '../rekordboxDbWriter';
import { isHostFile, keeperProblem } from '../keeperGuard';
import { hostEnvironment, toHostPath } from '../hostPath';
import { assertWritableLibraryPath } from '../librarySource';
import type { TrackPayload } from '../ipcContract';
import { shell } from 'electron';

/** Scans in flight, so a cancel request can reach the one it names. */
const activeOperations = new Map<string, { cancelled: boolean }>();

/**
 * Finding duplicates and resolving them, in an XML library or in
 * rekordbox's own database.
 */
export function registerDuplicateIpc(): void {
  ipcMain.handle('find-duplicates', async (_, options: {
    tracks: TrackPayload[];
    useFingerprint: boolean;
    useMetadata: boolean;
    metadataFields: string[];
    preferLossless?: boolean;
  }) => {
    const operationId = `dup-${Date.now()}`;
    const cancelToken = { cancelled: false };
    activeOperations.set(operationId, cancelToken);

    try {
      const send = (channel: string, payload: Record<string, unknown>) => {
        sendToWindow(channel, { operationId, ...payload });
      };
      send('duplicate-scan-progress', {
        type: 'start', current: 0, total: options.tracks.length, setsFound: 0
      });

      const { duplicates, cancelled } = await runtime().duplicateDetector.findDuplicates(
        options.tracks,
        options,
        {
          cancelToken,
          onProgress: (p) => send('duplicate-scan-progress', { type: 'progress', ...p }),
          onDuplicateSet: (set) => send('duplicate-scan-set', { set }),
        }
      );

      send('duplicate-scan-progress', {
        type: cancelled ? 'cancelled' : 'complete',
        current: options.tracks.length,
        total: options.tracks.length,
        setsFound: duplicates.length,
      });

      return { success: true, data: duplicates, cancelled, operationId };
    } catch (error) {
      runtime().logger.error('DUPLICATE_DETECTION_FAILED', {
        trackCount: options.tracks.length,
        options,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    } finally {
      activeOperations.delete(operationId);
    }
  });

  ipcMain.handle('merge-duplicates-in-db', async (_e, data: {
    dbPath: string; key: string; plans: MergePlan[]; deleteFromDisk?: boolean;
  }) => {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${data.dbPath}.backup.${stamp}`;
      const { removedLocations, remainingLocations, skipped, ...outcome } =
        mergeDuplicateEntries(data.dbPath, data.key, data.plans, { backupPath });
      // Files go only after the database write has succeeded, and only those
      // no entry left in the collection still uses.
      const trash = data.deleteFromDisk
        ? await trashUnreferencedFiles(removedLocations, remainingLocations)
        : { deleted: 0, trashed: [], failed: [] };
      return {
        success: true,
        ...outcome,
        backupPath,
        skipped,
        filesDeleted: trash.deleted,
        trashedPaths: trash.trashed,
        deleteErrors: trash.failed,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('cancel-duplicate-scan', async (_, operationId: string) => {
    const token = activeOperations.get(operationId);
    if (token) {
      token.cancelled = true;
      return { success: true };
    }
    return { success: false, error: 'Operation not found' };
  });

  ipcMain.handle('resolve-duplicates', async (_, resolution: {
    libraryPath: string;
    /** Which entry each set keeps — chosen by the renderer, which also showed it. */
    plans: MergePlan[];
    deleteFromDisk?: boolean;
  }) => {
    safeConsole.log(`🔧 IPC: Resolving ${resolution.plans.length} duplicate sets`);
    try {
      // Step 1: Create backup of original XML
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      // Saving writes XML; doing that to master.db would destroy the database.
      assertWritableLibraryPath(resolution.libraryPath);

      const backupPath = `${resolution.libraryPath}.backup.${timestamp}`;

      const fs = require('fs');
      fs.copyFileSync(resolution.libraryPath, backupPath);
      safeConsole.log(`📁 Backup created: ${backupPath}`);

      // Step 2: Parse current library
      const library = await runtime().rekordboxParser.parseLibrary(resolution.libraryPath);

      // Step 3: The entries to retire. The keeper was chosen in the renderer, so
      // the copy you saw marked and confirmed in the delete list is the one kept.
      const tracksToRemove: string[] = [];
      // removedTrackId -> keptTrackId, so playlist references can be re-pointed
      // (not dropped) and playlists stay complete.
      const replacement = new Map<string, string>();
      const skipped: Array<{ keepId: string; reason: string }> = [];

      for (const plan of resolution.plans) {
        // A keeper that is not in the library would leave the set with nothing.
        if (!library.tracks.has(plan.keepId)) {
          skipped.push({ keepId: plan.keepId, reason: 'the kept entry is no longer in the library' });
          continue;
        }
        const problem = keeperProblem(
          library.tracks.get(plan.keepId)?.location,
          plan.removeIds.filter((id) => id !== plan.keepId).map((id) => library.tracks.get(id)?.location),
          isHostFile
        );
        if (problem) { skipped.push({ keepId: plan.keepId, reason: problem }); continue; }
        for (const removeId of plan.removeIds) {
          if (removeId === plan.keepId || !library.tracks.has(removeId)) { continue; }
          tracksToRemove.push(removeId);
          replacement.set(removeId, plan.keepId);
        }
      }

      // Step 4: Remove tracks from library
      safeConsole.log(`🗑️ Removing ${tracksToRemove.length} duplicate tracks from library`);

      // Collect file locations before deleting from the Map
      const locationsToDelete: string[] = resolution.deleteFromDisk
        ? tracksToRemove
            .map(trackId => library.tracks.get(trackId)?.location)
            .filter((loc): loc is string => !!loc)
        : [];

      // Remove from tracks Map
      tracksToRemove.forEach(trackId => {
        library.tracks.delete(trackId);
      });

      // Re-point playlist references from each removed track to the kept track,
      // so playlists stay complete (a song that lived only in the removed
      // duplicate is preserved, now pointing at the kept file) and no playlist
      // gains a duplicate entry.
      substitutePlaylistTrackIds(library.playlists, replacement);

      // Step 5: Save updated library
      await runtime().rekordboxParser.saveLibrary(library, resolution.libraryPath);

      safeConsole.log(`✅ Successfully resolved duplicates: removed ${tracksToRemove.length} tracks`);
      runtime().logger.logLibrarySaving(resolution.libraryPath, library.tracks.size);

      // Step 6 (optional): Delete files from disk.
      const remainingLocations = Array.from(library.tracks.values())
        .map((t) => (t as TrackPayload | undefined)?.location)
        .filter((loc): loc is string => typeof loc === 'string' && loc.length > 0);
      const deleteResults = resolution.deleteFromDisk
        ? await trashUnreferencedFiles(locationsToDelete, remainingLocations)
        : { deleted: 0, trashed: [] as string[], failed: [] as { file: string; error: string }[] };

      return {
        success: true,
        backupPath,
        skipped,
        tracksRemoved: tracksToRemove.length,
        filesDeleted: deleteResults.deleted,
        trashedPaths: deleteResults.trashed,
        deleteErrors: deleteResults.failed,
        updatedLibrary: library
      };

    } catch (error) {
      safeConsole.error('❌ Resolution failed:', error);
      runtime().logger.error('DUPLICATE_RESOLUTION_FAILED', {
        duplicateSetsCount: resolution.plans.length,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  });
  }

/**
 * Move the files of retired entries to the OS trash.
 *
 * Several rekordbox entries can point at the SAME file. Only a path that no
 * remaining track still references goes, or we would destroy the audio
 * belonging to a track the user chose to keep. Trash rather than unlink, so a
 * wrong call is recoverable.
 */
async function trashUnreferencedFiles(
  candidates: string[],
  remainingLocations: string[]
): Promise<{ deleted: number; trashed: string[]; failed: { file: string; error: string }[] }> {
  // Compared in the library's spelling; under WSL the file itself is reached at /mnt/….
  const deletablePaths = computeDeletablePaths(candidates, remainingLocations, isHostFile);
  const env = hostEnvironment();
  const skipped = candidates.length - deletablePaths.length;
  if (skipped > 0) {
    safeConsole.log(`🛡️ Skipped ${skipped} path(s) still referenced by kept tracks, duplicated in the delete list, or not a file`);
  }

  const result = { deleted: 0, trashed: [] as string[], failed: [] as { file: string; error: string }[] };
  for (const loc of deletablePaths) {
    try {
      await shell.trashItem(toHostPath(loc, env));
      result.deleted++;
      result.trashed.push(loc);
      safeConsole.log(`🗑️ Moved to trash: ${loc}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      result.failed.push({ file: loc, error: msg });
      safeConsole.error(`❌ Failed to trash ${loc}: ${msg}`);
    }
  }
  return result;
}
