import { app, ipcMain } from 'electron';
import { withReadOnlyCopy } from '../rekordboxDbParser';
import { readHotCueCandidates, writeHotCuesToDb } from '../rekordboxDbHotCues';
import { readTrackAnalysis } from '../anlzReader';
import { isUsableGrid, suggestHotCues } from '../autoHotCue';
import { barLevels, decodeBass, findDrops } from '../bassDrops';
import { resolveFfmpegPath } from '../ffmpegBinary';
import { hostEnvironment, toHostPath } from '../hostPath';
import { runPool } from '../workerPool';
import { isRekordboxDatabasePath } from '../librarySource';
import { isRekordboxRunning } from '../rekordboxRunning';
import type {
  AutoHotCuePreview, AutoHotCuePreviewRequest, AutoHotCueTrack,
  AutoHotCueWriteRequest, AutoHotCueWriteSummary, IpcResult,
} from '../ipcContract';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Suggestion runs in flight, so a cancel can reach the one it names. */
const cancelTokens = new Map<string, { cancelled: boolean }>();

const ffmpegPath = () => resolveFfmpegPath({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
  platform: process.platform,
  arch: process.arch,
});

/**
 * Auto hot cues: suggest them from rekordbox's phrase analysis and the drops in
 * each track's bass, then write the ones the user kept. For rekordbox's
 * database only — the analysis files sit beside `master.db`.
 */
export function registerHotCueIpc(): void {
  ipcMain.handle('auto-hot-cue-preview', async (event, request: AutoHotCuePreviewRequest): Promise<IpcResult<AutoHotCuePreview>> => {
    const { operationId, libraryPath, dbKey, scopeTrackIds, beatsBefore, workers } = request;
    if (!isRekordboxDatabasePath(libraryPath)) {
      return { success: false, error: "Open rekordbox's database for this — its phrase analysis is read from beside master.db." };
    }
    if (!dbKey) { return { success: false, error: 'The database key is needed to read master.db.' }; }

    const cancelToken = { cancelled: false };
    cancelTokens.set(operationId, cancelToken);
    try {
      // Read on a copy, as loading is, so rekordbox may stay open while you look.
      const candidates = await withReadOnlyCopy(libraryPath, dbKey, (db) => readHotCueCandidates(db, scopeTrackIds));
      const analysed = candidates.tracks.flatMap((track) => {
        const { grid, phrases } = readTrackAnalysis(libraryPath, track.analysisDataPath);
        return grid && phrases && isUsableGrid(grid) ? [{ track, grid, phrases }] : [];
      });
      const notAnalysed = candidates.tracks.length - analysed.length;

      const ffmpeg = ffmpegPath();
      const env = hostEnvironment();
      let done = 0;
      let active = 0;
      let currentFile = '';
      let withoutDrops = 0;
      const report = () => event.sender.send('auto-hot-cue-progress', {
        operationId, current: done, total: analysed.length, active, currentFile,
      });
      const results = await runPool(analysed, workers, async ({ track, grid, phrases }) => {
        currentFile = track.title || track.location;
        let drops: number[] | undefined;
        if (ffmpeg) {
          try {
            const bass = await decodeBass(ffmpeg, toHostPath(track.location, env), cancelToken);
            drops = findDrops(barLevels(bass, grid), phrases.phrases.map((p) => p.beat));
          } catch { /* the file is missing or unreadable: cue it from the phrases alone */ }
        }
        if (!drops) { withoutDrops++; }
        done++;
        const cues = suggestHotCues(grid, phrases, { beatsBefore, drops });
        return cues.length > 0
          ? { trackId: track.id, title: track.title, artist: track.artist, location: track.location, cues }
          : null;
      }, cancelToken, (n) => { active = n; report(); });

      const tracks = results.filter((t): t is AutoHotCueTrack => Boolean(t));
      return {
        success: true,
        data: {
          tracks,
          alreadyCued: candidates.alreadyCued,
          notAnalysed: notAnalysed + (cancelToken.cancelled ? 0 : analysed.length - tracks.length),
          withoutDrops,
          cancelled: cancelToken.cancelled,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Preview failed' };
    } finally {
      cancelTokens.delete(operationId);
    }
  });

  ipcMain.handle('cancel-auto-hot-cue', async (_e, operationId: string) => {
    const token = cancelTokens.get(operationId);
    if (token) { token.cancelled = true; }
    return { success: true };
  });

  ipcMain.handle('auto-hot-cue-write', async (_e, request: AutoHotCueWriteRequest): Promise<IpcResult<AutoHotCueWriteSummary>> => {
    const { libraryPath, dbKey, tracks } = request;
    try {
      if (!isRekordboxDatabasePath(libraryPath)) { return { success: false, error: 'Hot cues are written into master.db only.' }; }
      if (!dbKey) { return { success: false, error: 'The database key is needed to write into master.db.' }; }
      if (isRekordboxRunning()) {
        return { success: false, error: 'Close rekordbox first — the hot cues are written into its database.' };
      }
      const outcome = writeHotCuesToDb(libraryPath, dbKey, tracks, { backupPath: `${libraryPath}.backup.${stamp()}` });
      return { success: true, data: outcome };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'The hot cues could not be written' };
    }
  });
}
