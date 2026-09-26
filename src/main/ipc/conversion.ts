import * as fs from 'fs';
import { app, ipcMain, shell } from 'electron';
import { runtime, safeConsole } from '../runtime';
import { resolveFfmpegPath } from '../ffmpegBinary';
import { FlacConverter, planConversions, isFlacLocation, type ConversionFormat } from '../flacConverter';
import { writeConversionsToDb } from '../rekordboxDbConverter';
import { writePlansFor, settleConversions, applyConversionsToLibrary, locationsStillUsed } from '../conversionSettlement';
import { backupDatabaseFile } from '../backupDatabase';
import { assertWritableLibraryPath, isRekordboxDatabasePath } from '../librarySource';
import { isRekordboxRunning } from '../rekordboxRunning';
import { hostEnvironment, toHostPath } from '../hostPath';
import type { TrackPayload, ConvertFlacPreview, ConvertFlacRequest, ConvertFlacSummary, IpcResult } from '../ipcContract';

/** Runs in flight, so a cancel request can reach the one it names. */
const cancelTokens = new Map<string, { cancelled: boolean }>();

const ffmpegPath = () => resolveFfmpegPath({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
  platform: process.platform,
  arch: process.arch,
});

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/**
 * The tracks with their locations as this machine's disk has them, and the
 * way back to the library's own spelling. Under WSL a Windows library stores
 * `C:/…`, which Linux can only reach as `/mnt/c/…`.
 */
function onThisDisk(tracks: TrackPayload[]) {
  const env = hostEnvironment();
  const libraryOf = new Map<string, string>();
  const hostTracks = tracks.map((track) => {
    const host = toHostPath(track.location, env);
    libraryOf.set(host, track.location);
    return { ...track, location: host };
  });
  return {
    hostTracks,
    libraryLocation: (host: string) => libraryOf.get(host) ?? host,
    toHost: (libraryPath: string) => toHostPath(libraryPath, env),
  };
}

/** The entries a run is limited to; all of them when no scope is given. */
function inScope(tracks: TrackPayload[], scopeTrackIds?: string[]): TrackPayload[] {
  if (!scopeTrackIds) { return tracks; }
  const ids = new Set(scopeTrackIds);
  return tracks.filter((t) => ids.has(t.id));
}

const isRegularFile = (p: string): boolean => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

const removeQuietly = (files: string[]) => {
  for (const file of files) {
    try { fs.rmSync(file, { force: true }); } catch (err) {
      safeConsole.error(`Could not remove ${file}:`, err);
    }
  }
};

/**
 * Converting FLAC to AIFF or WAV, and pointing the library at the result.
 *
 * The order is what keeps it safe: convert and verify every file first, then
 * write the library once, and only then touch an original — and only when
 * asked, and only to the trash. If the library write fails, the new files are
 * removed again, since nothing points at them, and the originals were never
 * touched.
 */
export function registerConversionIpc(): void {
  ipcMain.handle('convert-flac-preview', async (_e, { tracks: all, format, scopeTrackIds }: {
    tracks: TrackPayload[]; format: ConversionFormat; scopeTrackIds?: string[];
  }): Promise<IpcResult<ConvertFlacPreview>> => {
    try {
      const tracks = inScope(all, scopeTrackIds);
      const { hostTracks } = onThisDisk(tracks);
      const plan = planConversions(hostTracks, format);
      const flac = tracks.filter((t) => isFlacLocation(t.location));
      return {
        success: true,
        data: {
          available: ffmpegPath() !== null,
          flacTracks: flac.length,
          files: plan.jobs.length,
          missing: plan.skipped.filter((s) => s.kind === 'missing').length,
          conflicts: plan.skipped.filter((s) => s.kind === 'exists').length,
          totalSizeBytes: plan.jobs.reduce((sum, job) => sum + (job.size ?? 0), 0),
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Preview failed' };
    }
  });

  ipcMain.handle('convert-flac', async (event, request: ConvertFlacRequest): Promise<IpcResult<ConvertFlacSummary>> => {
    const { operationId, tracks: allTracks, scopeTrackIds, libraryPath, dbKey, format, trashOriginals } = request;
    const tracks = inScope(allTracks, scopeTrackIds);
    const ffmpeg = ffmpegPath();
    if (!ffmpeg) {
      return { success: false, error: 'This build of the app has no ffmpeg for this platform, so it cannot convert.' };
    }

    const isDatabase = isRekordboxDatabasePath(libraryPath);
    try {
      if (isDatabase) {
        // Checked before converting as well as at the write: finding out after
        // an hour of converting would be the worst time.
        if (isRekordboxRunning()) {
          return { success: false, error: 'Close rekordbox first — the converted tracks are written into its database.' };
        }
        if (!dbKey) { return { success: false, error: 'The database key is needed to write into master.db.' }; }
      } else {
        assertWritableLibraryPath(libraryPath);
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'The library cannot be written' };
    }

    const cancelToken = { cancelled: false };
    cancelTokens.set(operationId, cancelToken);
    try {
      const disk = onThisDisk(tracks);
      const plan = planConversions(disk.hostTracks, format);
      const result = await new FlacConverter(ffmpeg).convert(
        plan,
        format,
        (progress) => { event.sender.send('convert-flac-progress', { operationId, ...progress }); },
        cancelToken
      );

      // A cancelled run still writes what it finished: those files are
      // complete and verified, and leaving them unreferenced helps no one.
      const writePlans = writePlansFor(result.converted, disk.libraryLocation);
      let updatedTrackIds = new Set<string>();
      let writeSkipped: Array<{ trackId: string; reason: string }> = [];
      let backupPath: string | undefined;

      if (writePlans.length > 0) {
        backupPath = `${libraryPath}.backup.${stamp()}`;
        try {
          if (isDatabase) {
            const outcome = writeConversionsToDb(libraryPath, dbKey ?? '', writePlans, {
              backupPath,
              isRegularFile: (p) => isRegularFile(disk.toHost(p)),
            });
            writeSkipped = outcome.skipped;
            const skippedIds = new Set(outcome.skipped.map((s) => s.trackId));
            updatedTrackIds = new Set(writePlans.map((p) => p.trackId).filter((id) => !skippedIds.has(id)));
          } else {
            backupDatabaseFile(libraryPath, backupPath);
            const library = await runtime().rekordboxParser.parseLibrary(libraryPath);
            const outcome = applyConversionsToLibrary(library.tracks, writePlans);
            writeSkipped = outcome.skipped;
            updatedTrackIds = outcome.updatedTrackIds;
            if (outcome.tracksUpdated > 0) {
              await runtime().rekordboxParser.saveLibrary(library, libraryPath);
            }
          }
        } catch (error) {
          removeQuietly(result.converted.map((c) => c.newLocation));
          const message = error instanceof Error ? error.message : 'The library could not be written';
          return {
            success: false,
            error: `${message} The converted files were removed again; the FLAC originals were not touched.`,
          };
        }
      }

      const stillUsed = locationsStillUsed(onThisDisk(allTracks).hostTracks, updatedTrackIds);
      const settlement = settleConversions(result.converted, updatedTrackIds, stillUsed);
      removeQuietly(settlement.orphaned);

      const trashed: string[] = [];
      const trashFailed: Array<{ file: string; error: string }> = [];
      if (trashOriginals) {
        for (const original of settlement.trashable) {
          try {
            // The trash, never unlink: a wrong call stays recoverable.
            await shell.trashItem(original);
            trashed.push(original);
          } catch (err) {
            trashFailed.push({ file: original, error: err instanceof Error ? err.message : 'Unknown error' });
          }
        }
      }

      return {
        success: true,
        data: {
          filesConverted: settlement.kept.length,
          tracksUpdated: updatedTrackIds.size,
          skipped: [
            ...result.skipped.map(({ trackId, location, reason }) => ({ trackId, location, reason })),
            ...writeSkipped.map(({ trackId, reason }) => ({ trackId, reason })),
          ],
          failed: result.failed,
          cancelled: result.cancelled,
          trashed,
          trashFailed,
          backupPath,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Conversion failed' };
    } finally {
      cancelTokens.delete(operationId);
    }
  });

  ipcMain.handle('cancel-convert-flac', async (_e, operationId: string) => {
    const token = cancelTokens.get(operationId);
    if (token) { token.cancelled = true; }
    return { success: true };
  });
}
