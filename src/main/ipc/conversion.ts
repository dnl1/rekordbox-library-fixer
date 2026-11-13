import * as fs from 'fs';
import { ipcMain, shell } from 'electron';
import { runtime, safeConsole } from '../runtime';
import { appFfmpegPath } from '../appFfmpeg';
import {
  AudioConverter, planConversions, isConvertible, sourceKind, SOURCE_KINDS, type ConversionFormat, type SourceKind,
} from '../audioConverter';
import { writeConversionsToDb } from '../rekordboxDbConverter';
import { writePlansFor, settleConversions, applyConversionsToLibrary, locationsStillUsed } from '../conversionSettlement';
import { backupDatabaseFile } from '../backupDatabase';
import { assertWritableLibraryPath, isRekordboxDatabasePath } from '../librarySource';
import { isRekordboxRunning } from '../rekordboxRunning';
import { hostEnvironment, toHostPath } from '../hostPath';
import { planOriginalsCleanup, trashConvertedOriginals } from '../originalsCleanup';
import { parseDb } from '../rekordboxDbParser';
import type {
  TrackPayload, ConvertAudioPreview, ConvertAudioRequest, ConvertAudioSummary, IpcResult,
  OriginalsCleanupPreview, OriginalsCleanupRequest, OriginalsCleanupSummary,
} from '../ipcContract';

/** Runs in flight — conversions and cleanups — so a cancel request can reach the one it names. */
const cancelTokens = new Map<string, { cancelled: boolean }>();

const ffmpegPath = appFfmpegPath;

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
 * Converting FLAC, WAV and M4A to AIFF, WAV or MP3, and pointing the library at the result.
 *
 * The order is what keeps it safe: convert and verify every file first, then
 * write the library once, and only then touch an original — and only when
 * asked, and only to the trash. If the library write fails, the new files are
 * removed again, since nothing points at them, and the originals were never
 * touched.
 */
export function registerConversionIpc(): void {
  ipcMain.handle('convert-audio-preview', async (_e, { tracks: all, format, scopeTrackIds, sources }: {
    tracks: TrackPayload[]; format: ConversionFormat; scopeTrackIds?: string[]; sources?: SourceKind[];
  }): Promise<IpcResult<ConvertAudioPreview>> => {
    try {
      const tracks = inScope(all, scopeTrackIds);
      const { hostTracks } = onThisDisk(tracks);
      const plan = planConversions(hostTracks, format, undefined, sources);
      const filesByKind = Object.fromEntries(SOURCE_KINDS.map((k) => [k, 0])) as Record<SourceKind, number>;
      for (const job of plan.jobs) {
        const kind = sourceKind(job.source);
        if (kind) { filesByKind[kind]++; }
      }
      return {
        success: true,
        data: {
          available: ffmpegPath() !== null,
          sourceTracks: tracks.filter((t) => isConvertible(t.location, format, sources)).length,
          files: plan.jobs.length,
          filesByKind,
          reusable: plan.jobs.filter((job) => job.existing).length,
          missing: plan.skipped.filter((s) => s.kind === 'missing').length,
          conflicts: plan.skipped.filter((s) => s.kind === 'exists').length,
          totalSizeBytes: plan.jobs.reduce((sum, job) => sum + (job.size ?? 0), 0),
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Preview failed' };
    }
  });

  ipcMain.handle('convert-audio', async (event, request: ConvertAudioRequest): Promise<IpcResult<ConvertAudioSummary>> => {
    const { operationId, tracks: allTracks, scopeTrackIds, libraryPath, dbKey, format, sources, trashOriginals, workers } = request;
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
      const plan = planConversions(disk.hostTracks, format, undefined, sources);
      const result = await new AudioConverter(ffmpeg).convert(
        plan,
        format,
        (progress) => { event.sender.send('convert-audio-progress', { operationId, ...progress }); },
        cancelToken,
        workers
      );

      // A cancelled run still writes what it finished: those files are
      // complete and verified, and leaving them unreferenced helps no one.
      const writePlans = writePlansFor(result.converted, disk.libraryLocation);
      let updatedTrackIds = new Set<string>();
      let writeSkipped: Array<{ trackId: string; reason: string }> = [];
      let backupPath: string | undefined;

      // rekordbox may have been opened while the run went on. The write would
      // refuse and the failure below would delete every file this run made —
      // an hour of converting lost — when a second run can reuse them all.
      if (writePlans.length > 0 && isDatabase && isRekordboxRunning()) {
        return {
          success: false,
          error: 'rekordbox was opened while converting, so nothing was written into its database. '
            + `The ${result.converted.length} finished files are kept: close rekordbox and convert again, `
            + 'and each is checked against its original and reused.',
        };
      }

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
          removeQuietly(result.converted.filter((c) => !c.adopted).map((c) => c.newLocation));
          const message = error instanceof Error ? error.message : 'The library could not be written';
          return {
            success: false,
            error: `${message} The files converted by this run were removed again; the originals were not touched.`,
          };
        }
      }

      const stillUsed = locationsStillUsed(onThisDisk(allTracks).hostTracks, updatedTrackIds);
      const settlement = settleConversions(result.converted, updatedTrackIds, stillUsed);
      removeQuietly(settlement.orphaned);

      const trashed: string[] = [];
      const trashFailed: Array<{ file: string; error: string }> = [];
      // Only a database write moves rekordbox's own entries. An XML library is a
      // file rekordbox does not read by itself: its master.db still points at
      // every original, so trashing them would leave the real collection missing.
      if (trashOriginals && isDatabase) {
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

  ipcMain.handle('cancel-convert-audio', async (_e, operationId: string) => {
    const token = cancelTokens.get(operationId);
    if (token) { token.cancelled = true; }
    return { success: true };
  });

  registerOriginalsCleanupIpc();
}

/**
 * Trashing the originals a conversion left behind — FLAC, WAV, M4A. Only for
 * rekordbox's database: an XML library pointing at an AIFF says nothing about
 * rekordbox's own collection, which may still point at the original — the same reason Convert
 * trashes originals for a database only. Nothing is written into the
 * database, so rekordbox may stay open; what it points at is re-read before
 * anything goes.
 */
function registerOriginalsCleanupIpc(): void {
  ipcMain.handle('cleanup-originals-preview', async (_e, { tracks }: { tracks: TrackPayload[] }): Promise<IpcResult<OriginalsCleanupPreview>> => {
    try {
      const plan = planOriginalsCleanup(onThisDisk(tracks).hostTracks);
      const filesByKind = Object.fromEntries(SOURCE_KINDS.map((k) => [k, 0])) as Record<SourceKind, number>;
      for (const candidate of plan.candidates) {
        const kind = sourceKind(candidate.original);
        if (kind) { filesByKind[kind]++; }
      }
      return {
        success: true,
        data: {
          available: ffmpegPath() !== null,
          files: plan.candidates.length,
          filesByKind,
          totalSizeBytes: plan.candidates.reduce((sum, c) => sum + fileSize(c.original), 0),
          stillUsed: plan.stillUsed,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Preview failed' };
    }
  });

  ipcMain.handle('cleanup-originals', async (event, request: OriginalsCleanupRequest): Promise<IpcResult<OriginalsCleanupSummary>> => {
    const { operationId, tracks, libraryPath, dbKey, workers } = request;
    const ffmpeg = ffmpegPath();
    if (!ffmpeg) {
      return { success: false, error: 'This build of the app has no ffmpeg for this platform, so it cannot compare the audio.' };
    }
    if (!isRekordboxDatabasePath(libraryPath)) {
      return { success: false, error: "Open rekordbox's database for this — an XML library does not say which files rekordbox still uses." };
    }
    if (!dbKey) { return { success: false, error: 'The database key is needed to read master.db.' }; }

    const cancelToken = { cancelled: false };
    cancelTokens.set(operationId, cancelToken);
    try {
      const disk = onThisDisk(tracks);
      const converter = new AudioConverter(ffmpeg);
      const outcome = await trashConvertedOriginals(
        planOriginalsCleanup(disk.hostTracks),
        {
          sameAudio: (original, converted, token) => converter.sameAudio(original, converted, token),
          currentLocations: async () => {
            const library = await parseDb(libraryPath, dbKey);
            return [...library.tracks.values()].map((t) => disk.toHost(t.location));
          },
          trash: (file) => shell.trashItem(file),
        },
        (progress) => { event.sender.send('cleanup-originals-progress', { operationId, ...progress }); },
        cancelToken,
        workers
      );
      return { success: true, data: outcome };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Cleanup failed' };
    } finally {
      cancelTokens.delete(operationId);
    }
  });
}

const fileSize = (file: string): number => {
  try { return fs.statSync(file).size; } catch { return 0; }
};
