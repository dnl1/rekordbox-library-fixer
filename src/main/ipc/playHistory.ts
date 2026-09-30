import { ipcMain } from 'electron';
import { withReadOnlyCopy } from '../rekordboxDbParser';
import { readPlayHistory } from '../rekordboxDbHistory';
import { isRekordboxDatabasePath } from '../librarySource';
import type { IpcResult, PlayHistoryRequest, PlayHistorySession } from '../ipcContract';

/**
 * rekordbox's play history, read out of master.db. Read on a copy, as loading
 * is, so rekordbox may stay open — right after a set is when it gets looked at.
 */
export function registerPlayHistoryIpc(): void {
  ipcMain.handle('read-play-history', async (_e, request: PlayHistoryRequest): Promise<IpcResult<PlayHistorySession[]>> => {
    const libraryPath = request?.libraryPath ?? '';
    const dbKey = (request?.dbKey ?? '').trim();
    if (!isRekordboxDatabasePath(libraryPath)) {
      return { success: false, error: "Open rekordbox's database for this — the play history is read from master.db." };
    }
    if (!dbKey) { return { success: false, error: 'No database key — paste your master.db key in Settings.' }; }
    try {
      return { success: true, data: await withReadOnlyCopy(libraryPath, dbKey, readPlayHistory) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      // SQLCipher reports a wrong key as "file is not a database", as parse-rekordbox-db translates it.
      const wrongKey = /not a database|encrypt|cipher|key/i.test(message);
      return {
        success: false,
        error: wrongKey ? 'Could not decrypt the database — check the key.' : `Could not read the play history: ${message}`,
      };
    }
  });
}
