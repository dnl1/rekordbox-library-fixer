import { useCallback } from 'react';
import type { ShowNotification } from '../types';
import { useSettingsStore } from '../stores/settingsStore';
import { pickRecommendedTrack } from '../utils/pickRecommendedTrack';
import { normalizePathForCompare } from '../utils/normalizePath';
import { looksLikePlayableFile } from '../utils/classifyDuplicateSet';
import { duplicationHistoryStorage, type ActivityDetail } from '../db/duplicationHistoryDb';

type Skipped = Array<{ keepId: string; reason: string }>;

/** The sets the main process merged, apart from those it refused. */
function splitBySkipped<T>(sets: T[], plans: Array<{ keepId: string }>, skipped: Skipped = []) {
  const refused = new Set(skipped.map((s) => s.keepId));
  return {
    done: sets.filter((_, i) => !refused.has(plans[i].keepId)),
    left: sets.filter((_, i) => refused.has(plans[i].keepId)),
  };
}

/** Why some sets were left alone — they stay in the list to be looked at. */
function skippedNote(skipped: Skipped = []): string {
  if (skipped.length === 0) { return ''; }
  return `\n⚠️ ${skipped.length} set${skipped.length !== 1 ? 's were' : ' was'} left untouched: `
    + `${skipped[0].reason}${skipped.length > 1 ? ' (and others)' : ''}. `
    + 'Reconnect the drive or pick another copy to keep, then resolve again.';
}

function skippedDetails(skipped: Skipped = []): ActivityDetail[] {
  return skipped.map((s) => ({ action: 'failed' as const, from: s.keepId, error: s.reason }));
}

interface UseDuplicateResolutionArgs {
  duplicates: any[];
  libraryData: any;
  setLibraryData: (data: any) => void;
  selectedDuplicates: Set<string>;
  resolutionStrategy: string;
  scanOptions: any;
  libraryPath: string;
  deleteFromDisk: boolean;
  showNotification: ShowNotification;
  setDuplicates: (updater: any) => void;
  setSelections: (selections: string[]) => void;
  setIsScanning: (scanning: boolean) => void;
  clearAll: () => void;
  setPendingDeletePaths: (paths: string[] | null) => void;
  /** Reopens the library, so a database write shows up on the page. */
  onLoadLibrary?: (path: string) => void;
}

/**
 * Resolving a duplicate set, by whichever route the open library needs.
 *
 * Three steps that used to sit in the middle of the page component: working out
 * what would actually be deleted, writing the change (into rekordbox's database
 * or through the XML writer), and recording what happened.
 */
export function useDuplicateResolution({
  duplicates,
  libraryData,
  setLibraryData,
  selectedDuplicates,
  resolutionStrategy,
  scanOptions,
  libraryPath,
  deleteFromDisk,
  showNotification,
  setDuplicates,
  setSelections,
  setIsScanning,
  clearAll,
  setPendingDeletePaths,
  onLoadLibrary,
}: UseDuplicateResolutionArgs) {
  const isDatabase = libraryPath.toLowerCase().endsWith('.db');

  /**
   * The copy each set keeps. One choice, made here, drives the badge's rules,
   * the delete modal, the write and the history — the main process no longer
   * picks on its own, so what you confirm is what happens.
   */
  const keeperOf = useCallback((set: any) => {
    const { consolidateDestination } = useSettingsStore.getState();
    return pickRecommendedTrack(
      set.tracks, resolutionStrategy, set.pathPreferences, scanOptions.preferLossless, consolidateDestination
    ) ?? set.tracks[0];
  }, [resolutionStrategy, scanOptions.preferLossless]);

  const plansFor = useCallback((sets: any[]) => sets.map((d: any) => {
    const keepId = keeperOf(d).id;
    return { keepId, removeIds: d.tracks.filter((t: any) => t.id !== keepId).map((t: any) => t.id) };
  }), [keeperOf]);

  const resolveInDatabase = useCallback(async (withDelete: boolean) => {
    const selectedSets = duplicates.filter((d) => selectedDuplicates.has(d.id));
    if (selectedSets.length === 0) { return; }

    const { running } = await window.electronAPI.isRekordboxRunning();
    if (running) {
      showNotification('error', 'Close rekordbox first — it keeps its database open while it runs.');
      return;
    }

    const plans = plansFor(selectedSets);

    setIsScanning(true);
    try {
      const result = await window.electronAPI.mergeDuplicatesInDb({
        dbPath: libraryPath,
        key: useSettingsStore.getState().rekordboxDbKey,
        plans,
        deleteFromDisk: withDelete,
      });
      if (result.success) {
        const { done } = splitBySkipped(selectedSets, plans, result.skipped);
        const donePlans = splitBySkipped(plans, plans, result.skipped).done;
        let msg = `Merged ${done.length} set${done.length !== 1 ? 's' : ''} in rekordbox — `
          + `${result.entriesRemoved} extra entr${result.entriesRemoved === 1 ? 'y' : 'ies'} removed, `
          + `${result.playlistLinksMoved} playlist link${result.playlistLinksMoved === 1 ? '' : 's'} moved to the kept track.`;
        if (withDelete) {
          const trashed = result.filesDeleted ?? 0;
          msg += trashed > 0
            ? ` ${trashed} duplicate file${trashed !== 1 ? 's' : ''} moved to the trash.`
            : ' No files needed removing — every copy pointed at the same file.';
          if ((result.deleteErrors?.length ?? 0) > 0) {
            msg += ` (${result.deleteErrors!.length} could not be trashed — check paths)`;
          }
        }
        msg += ' Reopen rekordbox to see it. The database was backed up first — undo from the Backups tab.';
        msg += skippedNote(result.skipped);
        showNotification(result.skipped?.length ? 'warning' : 'success', msg, { important: true });
        const details: ActivityDetail[] = donePlans.flatMap((p) =>
          p.removeIds.map((id: string) => ({ action: 'merged' as const, from: id, to: p.keepId })));
        for (const trashed of (result.trashedPaths ?? [])) {
          details.push({ action: 'trashed', from: trashed });
        }
        for (const failure of (result.deleteErrors ?? [])) {
          details.push({ action: 'failed', from: failure.file, error: failure.error });
        }
        details.push(...skippedDetails(result.skipped));
        void duplicationHistoryStorage.record({
          libraryPath,
          timestamp: new Date(),
          type: 'duplicate-merge',
          summary: `Merged ${done.length} sets directly in the rekordbox database`
            + (withDelete ? `, ${result.filesDeleted ?? 0} file${result.filesDeleted !== 1 ? 's' : ''} to trash` : ''),
          backupPath: result.backupPath,
          details,
        });
        const merged = new Set(done.map((d: any) => d.id));
        setDuplicates((prev: any[]) => prev.filter((d) => !merged.has(d.id)));
        clearAll();
        // The page still holds the library as read before the write; without a
        // reopen the merged entries stay listed and a rescan finds them again.
        onLoadLibrary?.(libraryPath);
      } else {
        showNotification('error', result.error || 'Could not update the rekordbox database', { important: true });
      }
    } finally {
      setIsScanning(false);
    }
  }, [duplicates, selectedDuplicates, plansFor, libraryPath, showNotification, setDuplicates, clearAll, setIsScanning, onLoadLibrary]);

  const executeResolve = useCallback(async (withDelete: boolean) => {
    if (isDatabase) {
      await resolveInDatabase(withDelete);
      return;
    }
    const selectedDuplicateSets = duplicates.filter(d => selectedDuplicates.has(d.id));

    setIsScanning(true);
    showNotification('info', 'Creating backup and resolving duplicates...');

    try {
      const plans = plansFor(selectedDuplicateSets);
      const result = await window.electronAPI.resolveDuplicates({
        libraryPath,
        plans,
        deleteFromDisk: withDelete,
      });

      if (result.success) {
        const { done: doneSets } = splitBySkipped(selectedDuplicateSets, plans, result.skipped);
        const mergedIds = new Set(doneSets.map((d: any) => d.id));
        setDuplicates(duplicates.filter(d => !mergedIds.has(d.id)));
        setSelections([]);

        // Say what actually happened: duplicate entries are merged into the
        // copy you keep and playlists follow it. "Removed from XML" read like
        // music had been lost.
        const sets = doneSets.length;
        const merged = result.tracksRemoved ?? 0;
        let msg = `✅ Merged ${sets} duplicate set${sets !== 1 ? 's' : ''} — ${merged} extra entr${merged !== 1 ? 'ies' : 'y'} folded into the track you kept. Playlists now point at it.`;
        if (withDelete) {
          const trashed = result.filesDeleted ?? 0;
          msg += trashed > 0
            ? `\n🗑️ ${trashed} duplicate file${trashed !== 1 ? 's' : ''} moved to the trash`
            : '\n🗑️ No files needed removing — every copy pointed at the same file';
          if ((result.deleteErrors?.length ?? 0) > 0) {
            msg += ` (${result.deleteErrors!.length} could not be trashed — check paths)`;
          }
        }
        msg += `\n📁 Library backup: ${result.backupPath}`;
        msg += skippedNote(result.skipped);
        showNotification(result.skipped?.length ? 'warning' : 'success', msg, { important: true });

        // Record what happened so the History tab can be used to verify it.
        const details: ActivityDetail[] = [];
        for (const set of doneSets as any[]) {
          const keeper = keeperOf(set);
          for (const t of set.tracks) {
            if (t.id === keeper.id) { continue; }
            details.push({
              action: 'merged',
              trackName: `${t.artist} - ${t.name}`,
              from: t.location,
              to: keeper.location,
            });
          }
        }
        for (const trashed of (result.trashedPaths ?? [])) {
          details.push({ action: 'trashed', from: trashed });
        }
        for (const failure of (result.deleteErrors ?? [])) {
          details.push({ action: 'failed', from: failure.file, error: failure.error });
        }
        details.push(...skippedDetails(result.skipped));
        void duplicationHistoryStorage.record({
          libraryPath,
          timestamp: new Date(),
          type: 'duplicate-merge',
          summary: `Merged ${sets} duplicate set${sets !== 1 ? 's' : ''}`
            + ` — ${merged} entr${merged !== 1 ? 'ies' : 'y'} folded in`
            + (withDelete ? `, ${result.filesDeleted} file${result.filesDeleted !== 1 ? 's' : ''} to trash` : ''),
          backupPath: result.backupPath,
          details,
        });

        if (result.updatedLibrary && libraryData) {
          setLibraryData({
            ...libraryData,
            tracks: result.updatedLibrary.tracks,
            playlists: result.updatedLibrary.playlists || libraryData.playlists,
          });
        }
      } else {
        showNotification('error', `Failed to resolve duplicates: ${result.error}`);
      }
    } catch (error) {
      console.error('Resolution failed:', error);
      showNotification('error', 'Failed to resolve duplicates. Check console for details.');
    } finally {
      setIsScanning(false);
    }
  }, [isDatabase, resolveInDatabase, duplicates, selectedDuplicates, libraryPath, plansFor, keeperOf, libraryData, setDuplicates, setSelections, setLibraryData, showNotification, setIsScanning]);

  const resolveDuplicates = useCallback(async () => {
    if (selectedDuplicates.size === 0) {
      showNotification('error', 'Please select duplicates to resolve');
      return;
    }

    if (deleteFromDisk) {
      // Collect all file paths that will be removed so the modal can show them
      const selectedSets = duplicates.filter(d => selectedDuplicates.has(d.id));
      // Show only the paths that will actually be trashed: per set, drop the
      // copy that is kept, and drop any path the kept copy still uses (several
      // rekordbox entries can point at the same file — that file stays).
      const losingPaths = selectedSets.flatMap((d: any) => {
        const keeper = keeperOf(d);
        const keeperLocation = normalizePathForCompare(keeper.location);
        return d.tracks
          .filter((t: any) => t.id !== keeper.id)
          .map((t: any) => t.location)
          // Only real files can be trashed. Rekordbox also stores folders,
          // truncated locations and streaming ids; proposing those was alarming
          // and the backend refuses them anyway.
          .filter((loc: string) => loc && looksLikePlayableFile(loc)
            && normalizePathForCompare(loc) !== keeperLocation);
      });
      const uniquePaths = Array.from(new Set(losingPaths));
      if (uniquePaths.length === 0) {
        // Nothing to trash (e.g. every copy points at the same file) — don't
        // make the user confirm a deletion that would delete nothing.
        await executeResolve(false);
        return;
      }
      setPendingDeletePaths(uniquePaths);
      return;
    }

    await executeResolve(false);
  }, [selectedDuplicates, duplicates, deleteFromDisk, executeResolve, showNotification, keeperOf, setPendingDeletePaths]);

  return { resolveDuplicates, executeResolve, resolveInDatabase };
}
