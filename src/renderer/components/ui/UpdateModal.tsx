import React, { useEffect, useSyncExternalStore } from 'react';
import { X, Download, ExternalLink, RefreshCw, CheckCircle } from 'lucide-react';
import {
  subscribeUpdates, getUpdateSnapshot, closeUpdateDialog, checkForUpdates, installUpdate, cancelUpdateDownload,
} from '../../updates/updateSession';
import { useSettingsStore } from '../../stores/settingsStore';
import { formatFileSize } from '../../utils';
import type { UpdateInstallMode } from '../../../main/ipcContract';

const INSTALL_LABEL: Record<UpdateInstallMode, string> = {
  installer: 'Download and install',
  replace: 'Download, install and restart',
  package: 'Download and open the installer',
  manual: 'Open the release page',
};

/**
 * The release's own notes stop at the first rule: what follows is the
 * download table every release repeats, which says nothing about this one.
 */
const releaseNotes = (notes: string) => notes.split(/\r?\n-{3,}\s*\r?\n/)[0].trim();

export const UpdateModal: React.FC = () => {
  const s = useSyncExternalStore(subscribeUpdates, getUpdateSnapshot);
  const checkOnStart = useSettingsStore((st) => st.checkUpdatesOnStart);
  const setCheckOnStart = useSettingsStore((st) => st.setCheckUpdatesOnStart);

  // Opened from the menu with nothing checked yet: check now.
  useEffect(() => {
    if (s.dialogOpen && !s.result && !s.checking && !s.error) { void checkForUpdates(); }
  }, [s.dialogOpen, s.result, s.checking, s.error]);

  if (!s.dialogOpen) { return null; }

  const { result } = s;
  const latest = result?.latest;
  const pct = s.progress && s.progress.total > 0 ? Math.round((s.progress.received / s.progress.total) * 100) : 0;
  const openRelease = () => { if (latest) { void window.electronAPI.openExternal(latest.url); } };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" role="dialog" aria-label="Updates">
      <div className="bg-te-grey-800 border-2 border-te-grey-700 rounded-te p-6 max-w-lg w-full mx-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-te-cream font-te-display">Updates</h2>
          <button onClick={closeUpdateDialog} disabled={s.downloading} aria-label="Close"
            className="text-te-grey-400 hover:text-te-cream transition-colors disabled:opacity-40">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3 text-sm font-te-mono text-te-grey-300">
          {result && <div>This version: <span className="text-te-cream">{result.currentVersion}</span></div>}

          {s.checking && <div className="flex items-center gap-2"><RefreshCw className="w-4 h-4 animate-spin" /> Checking GitHub…</div>}

          {!s.checking && result && !result.available && (
            <div className="flex items-center gap-2 text-green-400">
              <CheckCircle className="w-4 h-4" /> You have the latest version.
            </div>
          )}

          {!s.checking && latest && (
            <>
              <div className="text-te-orange font-medium">
                Version {latest.version} is available{latest.prerelease ? ' (beta)' : ''}
                {latest.publishedAt && (
                  <span className="text-te-grey-400 font-normal"> — {new Date(latest.publishedAt).toLocaleDateString()}</span>
                )}
              </div>
              <div className="text-te-cream">{latest.name}</div>
              {releaseNotes(latest.notes) && (
                <div className="max-h-48 overflow-auto whitespace-pre-wrap bg-te-grey-900/40 border border-te-grey-700 rounded-te p-3 text-xs">
                  {releaseNotes(latest.notes)}
                </div>
              )}
              {result?.assetName && (
                <div className="text-xs text-te-grey-400">
                  {result.assetName}{result.assetSize ? ` — ${formatFileSize(result.assetSize)}` : ''}
                </div>
              )}
              {result?.install === 'manual' && (
                <div className="text-xs text-te-grey-400">
                  This build cannot install the update itself — download it from the release page.
                </div>
              )}
            </>
          )}

          {s.downloading && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span>{s.progress && s.progress.received >= s.progress.total ? 'Checking the download…' : 'Downloading…'}</span>
                {s.progress && <span>{formatFileSize(s.progress.received)} / {formatFileSize(s.progress.total)}</span>}
              </div>
              <div className="w-full bg-te-grey-700 rounded-full h-2">
                <div className="bg-te-orange h-2 rounded-full transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}

          {s.installed && (
            <div className="text-green-400">
              {s.installed.quitting
                ? 'Installing — the app closes now and opens again on the new version.'
                : 'The installer is open. Finish there, then start the app again.'}
            </div>
          )}

          {s.error && <div className="text-red-400">{s.error}</div>}

          <label htmlFor="check-updates-on-start" className="flex items-center gap-2 cursor-pointer pt-2">
            <input id="check-updates-on-start" type="checkbox" checked={checkOnStart}
              onChange={(e) => setCheckOnStart(e.target.checked)} className="accent-te-orange" />
            <span>Check for updates when the app starts</span>
          </label>
        </div>

        <div className="mt-6 flex flex-wrap gap-2 justify-end">
          {s.downloading ? (
            <button onClick={() => { void cancelUpdateDownload(); }} className="btn-secondary">Cancel</button>
          ) : (
            <>
              <button onClick={() => { void checkForUpdates(); }} disabled={s.checking}
                className="btn-secondary flex items-center gap-2 disabled:opacity-40">
                <RefreshCw className="w-4 h-4" /> Check again
              </button>
              {latest && (
                <button onClick={openRelease} className="btn-secondary flex items-center gap-2">
                  <ExternalLink className="w-4 h-4" /> Release page
                </button>
              )}
              {latest && result && result.install !== 'manual' && !s.installed?.quitting && (
                <button onClick={() => { void installUpdate(); }} disabled={s.checking}
                  className="btn-primary flex items-center gap-2 disabled:opacity-40">
                  <Download className="w-4 h-4" /> {INSTALL_LABEL[result.install]}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
