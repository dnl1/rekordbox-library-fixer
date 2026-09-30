import { ipcMain, dialog, app } from 'electron';
import * as path from 'path';
import { runtime, getMainWindow, sendToWindow } from '../runtime';
import { hostEnvironment, toHostPath } from '../hostPath';
import { planPlaylistZip, safeFileName, statSize, writePlaylistZip } from '../playlistZip';
import type {
  IpcResult, PlaylistZipPreview, PlaylistZipPreviewRequest, PlaylistZipRequest, PlaylistZipSummary,
} from '../ipcContract';

const cancelTokens = new Map<string, { cancelled: boolean }>();

const planFor = (request: PlaylistZipPreviewRequest) => {
  const env = hostEnvironment();
  return planPlaylistZip(request.tracks, request.numbered, {
    sizeOf: statSize,
    toHost: (p) => toHostPath(p, env),
  });
};

const fileNameFrom = (name: string) => safeFileName(name).trim() || 'playlist';

/**
 * Exporting a playlist's files, and nothing else, as a zip.
 */
export function registerExportIpc(): void {
  ipcMain.handle('choose-playlist-zip-path', async (_e, suggestedName: string): Promise<IpcResult<{ filePath: string | null }>> => {
    const window = getMainWindow();
    const options = {
      title: 'Export playlist as ZIP',
      defaultPath: path.join(app.getPath('downloads'), `${fileNameFrom(suggestedName)}.zip`),
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) { return { success: true, data: { filePath: null } }; }
    const filePath = result.filePath.toLowerCase().endsWith('.zip') ? result.filePath : `${result.filePath}.zip`;
    return { success: true, data: { filePath } };
  });

  ipcMain.handle('playlist-zip-preview', async (_e, request: PlaylistZipPreviewRequest): Promise<IpcResult<PlaylistZipPreview>> => {
    try {
      const plan = planFor(request);
      return {
        success: true,
        data: {
          files: plan.entries.length,
          totalSizeBytes: plan.totalBytes,
          skipped: plan.skipped.map(({ location, reason }) => ({ location, reason })),
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('export-playlist-zip', async (_e, request: PlaylistZipRequest): Promise<IpcResult<PlaylistZipSummary>> => {
    const token = { cancelled: false };
    cancelTokens.set(request.operationId, token);
    try {
      if (!request.outputPath.toLowerCase().endsWith('.zip')) {
        return { success: false, error: 'The export must be saved as a .zip file.' };
      }
      const plan = planFor(request);
      if (plan.entries.length === 0) {
        return { success: false, error: 'None of this playlist’s files are on disk.' };
      }
      // A zip written into the folder it is being filled from would end up inside itself.
      const output = path.resolve(request.outputPath).normalize('NFC');
      if (plan.entries.some((e) => path.resolve(e.source).normalize('NFC') === output)) {
        return { success: false, error: 'Choose a different name — that file is one of the tracks.' };
      }

      const summary = await writePlaylistZip(
        plan,
        request.outputPath,
        (p) => sendToWindow('playlist-zip-progress', { operationId: request.operationId, ...p }),
        () => token.cancelled,
      );
      runtime().logger.info('PLAYLIST_ZIP_EXPORTED', {
        outputPath: summary.outputPath, files: summary.filesAdded, bytes: summary.bytes,
        skipped: summary.skipped.length, cancelled: summary.cancelled,
      });
      return { success: true, data: summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime().logger.error('PLAYLIST_ZIP_FAILED', { outputPath: request.outputPath, error: message });
      return { success: false, error: `The export failed: ${message}` };
    } finally {
      cancelTokens.delete(request.operationId);
    }
  });

  ipcMain.handle('cancel-playlist-zip', async (_e, operationId: string) => {
    const token = cancelTokens.get(operationId);
    if (token) { token.cancelled = true; }
    return { success: !!token };
  });
}
