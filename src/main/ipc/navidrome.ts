import * as path from 'path';
import { app, ipcMain, safeStorage } from 'electron';
import { createSubsonicClient, normalizeServerUrl, type NavidromeConnection } from '../navidrome/subsonic';
import { connectionPath, forgetConnection, loadConnection, saveConnection } from '../navidrome/credentials';
import { downloadToFile } from '../navidrome/importFiles';
import { runNavidromeImport } from '../navidrome/importRun';
import { importIntoDb } from '../rekordboxDbImport';
import { isRekordboxDatabasePath } from '../librarySource';
import { isRekordboxRunning } from '../rekordboxRunning';
import type {
  IpcResult, NavidromeConnectionInfo, NavidromeConnectionRequest, NavidromeImportRequest, NavidromeImportSummary,
  NavidromePlaylist, NavidromeServerStatus, NavidromeSong,
} from '../ipcContract';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const file = () => connectionPath(app.getPath('userData'));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Import runs in flight, so a cancel can reach the one it names. */
const cancelTokens = new Map<string, { cancelled: boolean; controller: AbortController }>();

function savedConnection(): NavidromeConnection {
  const conn = loadConnection(file(), safeStorage);
  if (!conn) { throw new Error('Connect to Navidrome in Settings first.'); }
  return conn;
}

/**
 * Navidrome: the connection (kept with the password encrypted by the system
 * keychain), browsing its playlists and songs, and importing them into
 * rekordbox's database. Every call to the server is made from here, so the
 * password never reaches the renderer.
 */
export function registerNavidromeIpc(): void {
  ipcMain.handle('navidrome-connection', async (): Promise<IpcResult<NavidromeConnectionInfo | null>> => {
    const conn = loadConnection(file(), safeStorage);
    const data = conn ? { url: conn.url, username: conn.username, hasPassword: Boolean(conn.password) } : null;
    return { success: true, data };
  });

  // Saved only once the server has accepted it: a typo is reported, not kept.
  ipcMain.handle('navidrome-save-connection', async (_e, request: NavidromeConnectionRequest): Promise<IpcResult<NavidromeServerStatus>> => {
    try {
      const url = normalizeServerUrl(request?.url ?? '');
      const username = (request?.username ?? '').trim();
      let password = request?.password ?? '';
      if (!password) {
        const saved = loadConnection(file(), safeStorage);
        const sameAccount = saved && normalizeServerUrl(saved.url) === url && saved.username === username;
        if (saved && sameAccount) { password = saved.password; }
      }
      if (!username || !password) { return { success: false, error: 'Type the username and the password.' }; }
      const conn = { url, username, password };
      const info = await createSubsonicClient(conn).ping();
      saveConnection(file(), conn, safeStorage);
      return { success: true, data: { serverVersion: info.serverVersion, apiVersion: info.apiVersion } };
    } catch (error) {
      return { success: false, error: message(error) };
    }
  });

  ipcMain.handle('navidrome-forget-connection', async (): Promise<IpcResult> => {
    forgetConnection(file());
    return { success: true };
  });

  ipcMain.handle('navidrome-playlists', async (): Promise<IpcResult<NavidromePlaylist[]>> => {
    try { return { success: true, data: await createSubsonicClient(savedConnection()).playlists() }; }
    catch (error) { return { success: false, error: message(error) }; }
  });

  ipcMain.handle('navidrome-playlist-songs', async (_e, id: string): Promise<IpcResult<NavidromeSong[]>> => {
    try { return { success: true, data: (await createSubsonicClient(savedConnection()).playlist(String(id))).songs }; }
    catch (error) { return { success: false, error: message(error) }; }
  });

  ipcMain.handle('navidrome-search', async (_e, query: string): Promise<IpcResult<NavidromeSong[]>> => {
    const text = String(query ?? '').trim();
    if (!text) { return { success: true, data: [] }; }
    try { return { success: true, data: await createSubsonicClient(savedConnection()).searchSongs(text) }; }
    catch (error) { return { success: false, error: message(error) }; }
  });

  ipcMain.handle('navidrome-default-destination', async (): Promise<IpcResult<string>> => {
    let music: string;
    try { music = app.getPath('music'); } catch { music = path.join(app.getPath('home'), 'Music'); }
    return { success: true, data: path.join(music, 'Navidrome') };
  });

  ipcMain.handle('navidrome-import', async (event, request: NavidromeImportRequest): Promise<IpcResult<NavidromeImportSummary>> => {
    const { operationId, libraryPath, dbKey } = request ?? ({} as NavidromeImportRequest);
    if (!isRekordboxDatabasePath(libraryPath)) {
      return { success: false, error: "Open rekordbox's database for this — the tracks are written into master.db." };
    }
    if (!dbKey) { return { success: false, error: 'The database key is needed to write into master.db.' }; }
    const cancelToken = { cancelled: false, controller: new AbortController() };
    cancelTokens.set(operationId, cancelToken);
    try {
      const summary = await runNavidromeImport(request, {
        client: createSubsonicClient(savedConnection()),
        download: downloadToFile,
        writeDb: (tracks, playlists) => importIntoDb(libraryPath, dbKey, tracks, playlists, {
          backupPath: `${libraryPath}.backup.${stamp()}-navidrome`,
        }),
        isRekordboxRunning,
        onProgress: (progress) => event.sender.send('navidrome-import-progress', progress),
        cancelToken,
      });
      return { success: true, data: summary };
    } catch (error) {
      return { success: false, error: message(error) };
    } finally {
      cancelTokens.delete(operationId);
    }
  });

  ipcMain.handle('navidrome-cancel-import', async (_e, operationId: string) => {
    const token = cancelTokens.get(operationId);
    if (token) { token.cancelled = true; token.controller.abort(); }
    return { success: true };
  });
}
