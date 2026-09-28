import { ipcMain } from 'electron';
import { withReadOnlyCopy } from '../rekordboxDbParser';
import { readHotCueCandidates, writeHotCuesToDb } from '../rekordboxDbHotCues';
import { readTrackAnalysis } from '../anlzReader';
import { isUsableGrid, suggestHotCues } from '../autoHotCue';
import { isRekordboxDatabasePath } from '../librarySource';
import { isRekordboxRunning } from '../rekordboxRunning';
import type {
  AutoHotCuePreview, AutoHotCuePreviewRequest, AutoHotCueTrack,
  AutoHotCueWriteRequest, AutoHotCueWriteSummary, IpcResult,
} from '../ipcContract';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/**
 * Auto hot cues: suggest them from rekordbox's phrase analysis, then write the
 * ones the user kept. For rekordbox's database only — the analysis files it
 * reads sit beside `master.db`, and an XML import cannot be trusted to leave
 * the cues where they were put.
 */
export function registerHotCueIpc(): void {
  ipcMain.handle('auto-hot-cue-preview', async (_e, request: AutoHotCuePreviewRequest): Promise<IpcResult<AutoHotCuePreview>> => {
    const { libraryPath, dbKey, scopeTrackIds, beatsBefore } = request;
    if (!isRekordboxDatabasePath(libraryPath)) {
      return { success: false, error: "Open rekordbox's database for this — its phrase analysis is read from beside master.db." };
    }
    if (!dbKey) { return { success: false, error: 'The database key is needed to read master.db.' }; }
    try {
      // Read on a copy, as loading is, so rekordbox may stay open while you look.
      const candidates = await withReadOnlyCopy(libraryPath, dbKey, (db) => readHotCueCandidates(db, scopeTrackIds));
      const tracks: AutoHotCueTrack[] = [];
      let notAnalysed = 0;
      for (const track of candidates.tracks) {
        const { grid, phrases } = readTrackAnalysis(libraryPath, track.analysisDataPath);
        const cues = grid && phrases && isUsableGrid(grid) ? suggestHotCues(grid, phrases, { beatsBefore }) : [];
        if (cues.length === 0) { notAnalysed++; continue; }
        tracks.push({ trackId: track.id, title: track.title, artist: track.artist, location: track.location, cues });
      }
      return { success: true, data: { tracks, alreadyCued: candidates.alreadyCued, notAnalysed } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Preview failed' };
    }
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
