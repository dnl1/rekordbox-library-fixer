import * as path from 'path';
import { app, ipcMain, dialog } from 'electron';
import { runtime } from '../runtime';
import { detectRekordboxDb } from '../rekordboxDbLocator';
import { scanForLibraries } from '../libraryScanner';
import { isRekordboxRunning } from '../rekordboxRunning';
import { handleParseRekordboxDb } from '../rekordboxDbIpc';
import { parseDb, keyOpensDatabase } from '../rekordboxDbParser';
import { assertWritableLibraryPath } from '../librarySource';
import { recoverDbKey } from '../dbKeyRecovery';
import { keyFromPyrekordboxPackage } from '../dbKeyFromPackage';
import type { IpcResult, RecoveredDbKey } from '../ipcContract';

/**
 * Opening a library: the file dialogs, the XML parser, rekordbox's
 * database, and finding what this machine already has.
 */
const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function registerLibraryIpc(): void {
  ipcMain.handle('file-exists', async (_, path: string) => {
    const fs = require('fs');
    try {
      await fs.promises.access(path, fs.constants.R_OK);
      return { accessible: true };
    } catch {
      return { accessible: false };
    }
  });

  ipcMain.handle('select-rekordbox-xml', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Rekordbox XML', extensions: ['xml'] },
        { name: 'Rekordbox database (master.db)', extensions: ['db'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      defaultPath: path.join(
        process.env.HOME || '',
        'Library',
        'Pioneer',
        'rekordbox'
      ),
    });

    if (!result.canceled && result.filePaths[0]) {
      return result.filePaths[0];
    }
    return null;
  });

  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Music Folder',
      defaultPath: path.join(
        process.env.HOME || '',
        'Music'
      ),
    });

    if (!result.canceled && result.filePaths[0]) {
      return result.filePaths[0];
    }
    return null;
  });

  ipcMain.handle('parse-rekordbox-library', async (_, xmlPath: string) => {
    try {
      const library = await runtime().rekordboxParser.parseLibrary(xmlPath);
      runtime().logger.logLibraryParsing(xmlPath, library.tracks.size, library.playlists.length);

      // Include the libraryPath in the returned data to match LibraryData interface
      const libraryData = {
        ...library,
        libraryPath: xmlPath
      };

      return { success: true, data: libraryData };
    } catch (error) {
      runtime().logger.error('LIBRARY_PARSING_FAILED', {
        xmlPath,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  });

  ipcMain.handle('detect-rekordbox-db', async () => detectRekordboxDb());

  ipcMain.handle('scan-for-libraries', async () => scanForLibraries());

  /**
   * The key, from pyrekordbox, two ways. First the package itself, fetched
   * from PyPI and read here — no Python needed. Then, if that cannot be done
   * (offline, a pyrekordbox that keeps the key elsewhere), by running it with
   * the machine's Python. Either way the key is checked against the database
   * the user is opening before it is handed back.
   */
  ipcMain.handle('recover-db-key', async (_e, dbPath?: string): Promise<IpcResult<RecoveredDbKey>> => {
    const opensDatabase = dbPath ? (key: string) => keyOpensDatabase(dbPath, key) : undefined;

    const fromPackage = await keyFromPyrekordboxPackage({ opensDatabase });
    if (fromPackage.ok) {
      return { success: true, data: { key: fromPackage.key, installed: false, source: 'package' } };
    }

    // pyrekordbox goes into an environment of the app's own if the machine's
    // Python lacks it, so the user's packages are left alone.
    const viaPython = await recoverDbKey(process.platform, undefined, path.join(app.getPath('userData'), 'pyrekordbox'));
    if (viaPython.ok && (!opensDatabase || await opensDatabase(viaPython.key))) {
      return { success: true, data: { key: viaPython.key, installed: viaPython.installed, source: 'python' } };
    }
    const pythonDetail = viaPython.ok ? 'the key pyrekordbox gives does not open this database' : viaPython.detail;
    return { success: false, error: `${capitalise(fromPackage.detail)}. With Python: ${pythonDetail}` };
  });

  ipcMain.handle('is-rekordbox-running', async () => ({ running: isRekordboxRunning() }));

  ipcMain.handle('parse-rekordbox-db', async (_e, args: { dbPath: string; key: string }) =>
    handleParseRekordboxDb(args, parseDb));

  ipcMain.handle('save-rekordbox-xml', async (_, data: {
    library: Parameters<ReturnType<typeof runtime>['rekordboxParser']['saveLibrary']>[0];
    outputPath: string;
  }) => {
    try {
      assertWritableLibraryPath(data.outputPath);
      await runtime().rekordboxParser.saveLibrary(data.library, data.outputPath);
      runtime().logger.logLibrarySaving(data.outputPath, data.library.tracks.size);
      return { success: true };
    } catch (error) {
      runtime().logger.error('LIBRARY_SAVING_FAILED', {
        outputPath: data.outputPath,
        trackCount: data.library.tracks ? data.library.tracks.size : 0,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  });
  }
