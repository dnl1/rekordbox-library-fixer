import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { app, ipcMain, shell } from 'electron';
import { runtime, sendToWindow } from '../runtime';
import {
  fetchReleases, newestRelease, pickAsset, downloadVerified, macSwapScript, macBundlePath,
  type GithubAsset, type InstallTarget,
} from '../appUpdate';
import type { IpcResult, UpdateCheckResult, UpdateInstallMode, UpdateInstallResult } from '../ipcContract';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether the running .app can be swapped: not translocated by Gatekeeper, and its folder writable. */
function macBundleReplaceable(): boolean {
  const bundle = macBundlePath(process.execPath);
  if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/')) { return false; }
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function installTarget(): InstallTarget {
  return {
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    appImagePath: process.env.APPIMAGE,
    macBundleReplaceable: process.platform === 'darwin' && macBundleReplaceable(),
  };
}

/** What the last check found, so installing downloads exactly what was shown. */
let pending: { asset: GithubAsset; mode: UpdateInstallMode } | null = null;
let download: AbortController | null = null;

const quitSoon = () => { setTimeout(() => app.quit(), 300); };

async function install(file: string, mode: UpdateInstallMode, dir: string): Promise<UpdateInstallResult> {
  if (mode === 'installer') {
    // What electron-updater passes too: install over the current copy without
    // the wizard, then start the new version once the app has closed.
    spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    quitSoon();
    return { mode, quitting: true };
  }

  if (mode === 'replace' && process.platform === 'darwin') {
    const extracted = path.join(dir, 'extracted');
    await fs.promises.rm(extracted, { recursive: true, force: true });
    await fs.promises.mkdir(extracted, { recursive: true });
    await promisify(execFile)('ditto', ['-x', '-k', file, extracted]);
    const bundle = (await fs.promises.readdir(extracted)).find((n) => n.endsWith('.app'));
    if (!bundle) { throw new Error('The downloaded zip holds no app.'); }
    const script = path.join(dir, 'install.sh');
    await fs.promises.writeFile(
      script, macSwapScript(process.pid, path.join(extracted, bundle), macBundlePath(process.execPath)), { mode: 0o755 }
    );
    spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
    quitSoon();
    return { mode, quitting: true };
  }

  if (mode === 'replace' && process.env.APPIMAGE) {
    // Staged beside the running AppImage, so the rename is on one disk and
    // either the old file or the new one is there, never half of one.
    const target = process.env.APPIMAGE;
    const staged = `${target}.update`;
    await fs.promises.copyFile(file, staged);
    await fs.promises.chmod(staged, 0o755);
    await fs.promises.rename(staged, target);
    app.relaunch({ execPath: target, args: [] });
    quitSoon();
    return { mode, quitting: true };
  }

  if (mode === 'package') {
    const failure = await shell.openPath(file);
    if (failure) { throw new Error(`The installer could not be opened: ${failure}`); }
    return { mode, quitting: false, filePath: file };
  }

  throw new Error('This build cannot install updates itself — download it from the release page.');
}

/**
 * Checking for and installing new versions from the GitHub releases.
 */
export function registerUpdateIpc(): void {
  ipcMain.handle('check-for-updates', async (): Promise<IpcResult<UpdateCheckResult>> => {
    const currentVersion = app.getVersion();
    try {
      const latest = newestRelease(await fetchReleases(), currentVersion);
      pending = latest ? pickAsset(latest.assets, installTarget()) : null;
      return {
        success: true,
        data: {
          currentVersion,
          available: !!latest,
          latest: latest ? {
            version: latest.tag_name.replace(/^v/i, ''),
            name: latest.name || latest.tag_name,
            notes: latest.body ?? '',
            url: latest.html_url,
            publishedAt: latest.published_at ?? undefined,
            prerelease: latest.prerelease,
          } : undefined,
          install: pending?.mode ?? 'manual',
          assetName: pending?.asset.name,
          assetSize: pending?.asset.size,
        },
      };
    } catch (error) {
      runtime().logger.error('UPDATE_CHECK_FAILED', { error: errorText(error) });
      return { success: false, error: `Could not check for updates: ${errorText(error)}` };
    }
  });

  ipcMain.handle('install-update', async (): Promise<IpcResult<UpdateInstallResult>> => {
    if (!pending) { return { success: false, error: 'Check for updates first.' }; }
    if (download) { return { success: false, error: 'The update is already downloading.' }; }
    const { asset, mode } = pending;
    const dir = path.join(app.getPath('temp'), 'rekordbox-library-fixer-update');
    download = new AbortController();
    try {
      const file = await downloadVerified(
        asset, dir, (received, total) => sendToWindow('update-download-progress', { received, total }), download.signal
      );
      runtime().logger.info('UPDATE_DOWNLOADED', { asset: asset.name, mode });
      return { success: true, data: await install(file, mode, dir) };
    } catch (error) {
      if (download?.signal.aborted) { return { success: false, error: 'Download cancelled.' }; }
      runtime().logger.error('UPDATE_INSTALL_FAILED', { asset: asset.name, error: errorText(error) });
      return { success: false, error: errorText(error) };
    } finally {
      download = null;
    }
  });

  ipcMain.handle('cancel-update-download', async () => {
    download?.abort();
    return { success: true };
  });
}
