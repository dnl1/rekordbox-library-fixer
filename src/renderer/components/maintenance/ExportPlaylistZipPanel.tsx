import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Archive, CheckCircle, FolderOpen, X } from 'lucide-react';
import { useAppContext } from '../../AppWithRouter';
import { formatFileSize } from '../../utils';
import { playlistScopes } from '../../utils/playlistScopes';
import {
  subscribePlaylistZip, getPlaylistZipSnapshot, startPlaylistZip, cancelPlaylistZip, resetPlaylistZipSession,
} from '../../export/playlistZipSession';
import type { PlaylistZipPreview, TrackPayload } from '../../../main/ipcContract';

/**
 * A playlist's audio files in one zip — to hand a set to someone, or to carry
 * it to a player that is not fed from rekordbox. Only the files: the zip holds
 * no library, cues or folders, and nothing in the library changes.
 */
export const ExportPlaylistZipPanel: React.FC = () => {
  const { libraryData, showNotification } = useAppContext();
  const session = useSyncExternalStore(subscribePlaylistZip, getPlaylistZipSnapshot);
  const scopes = useMemo(() => playlistScopes(libraryData?.playlists ?? []), [libraryData]);

  const [scopeKey, setScopeKey] = useState(() => session.scopeKey);
  const [numbered, setNumbered] = useState(false);
  const [preview, setPreview] = useState<PlaylistZipPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const scope = scopes.find((s) => s.key === scopeKey);
  const mine = session.scopeKey === scopeKey;
  const running = session.running;
  const summary = mine && !running ? session.summary : null;
  const error = mine && !running ? session.error : null;
  const progress = running ? session.progress : null;

  // Only what the export needs crosses the bridge, in the playlist's order.
  const tracks = useMemo<TrackPayload[]>(() => {
    if (!scope || !libraryData) { return []; }
    return scope.trackIds
      .map((id) => libraryData.tracks.get(id))
      .filter(Boolean)
      .map((t) => ({ id: t.id, name: t.name, artist: t.artist, location: t.location }));
  }, [scope, libraryData]);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!scope) { return; }
    let current = true;
    setPreviewing(true);
    void window.electronAPI.playlistZipPreview({ tracks, numbered }).then((res) => {
      if (!current) { return; }
      setPreview(res.success && res.data ? res.data : null);
      setPreviewError(res.success ? null : (res.error ?? 'Could not check the files'));
      setPreviewing(false);
    });
    return () => { current = false; };
  }, [scope, tracks, numbered]);

  const exportZip = async () => {
    if (!scope) { return; }
    const chosen = await window.electronAPI.choosePlaylistZipPath(scope.label.split(' / ').pop() ?? 'playlist');
    const outputPath = chosen.success ? chosen.data?.filePath : null;
    if (!outputPath) { return; }

    const res = await startPlaylistZip(scope.key, { tracks, numbered, outputPath });
    if (!res.success || !res.data) {
      showNotification('error', res.error ?? 'Export failed', { important: true });
      return;
    }
    const s = res.data;
    showNotification(
      s.cancelled ? 'warning' : 'success',
      s.cancelled
        ? 'Export cancelled — no zip was left behind.'
        : `Exported ${s.filesAdded} file${s.filesAdded === 1 ? '' : 's'} (${formatFileSize(s.bytes)}) to ${s.outputPath}`
          + `${s.skipped.length > 0 ? `. ${s.skipped.length} skipped.` : ''}`,
      { important: true }
    );
  };

  const pct = progress && progress.totalBytes > 0 ? Math.round((progress.bytesWritten / progress.totalBytes) * 100) : 0;

  return (
    <div className="bg-white rounded-te shadow-sm p-te-md mt-te-md">
      <h3 className="font-semibold text-te-grey-800 mb-1">Export playlist as ZIP</h3>
      <p className="text-sm text-te-grey-500 font-te-mono mb-te-md">
        Puts a playlist&apos;s audio files into one zip, side by side — nothing else, and nothing in the
        library changes.
      </p>

      {!libraryData ? (
        <p className="text-sm text-te-grey-400 italic">Load a library first to export.</p>
      ) : scopes.length === 0 ? (
        <p className="text-sm text-te-grey-400 italic">This library has no playlists with tracks in them.</p>
      ) : (
        <div className="space-y-te-md">
          <div>
            <label htmlFor="zip-scope" className="block text-xs font-medium text-te-grey-600 mb-1 uppercase">Playlist</label>
            <select
              id="zip-scope"
              value={scopeKey}
              disabled={running}
              onChange={(e) => { setScopeKey(e.target.value); resetPlaylistZipSession(); }}
              className="w-full border border-te-grey-300 rounded-te px-3 py-2 text-sm font-te-mono bg-te-cream focus:outline-none focus:border-te-orange"
            >
              <option value="">Choose a playlist…</option>
              {scopes.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.isFolder ? 'Folder' : 'Playlist'}: {s.label} ({s.trackIds.length})
                </option>
              ))}
            </select>
          </div>

          <label htmlFor="zip-numbered" className="flex items-center gap-2 cursor-pointer">
            <input
              id="zip-numbered"
              type="checkbox"
              checked={numbered}
              disabled={running}
              onChange={(e) => setNumbered(e.target.checked)}
              className="accent-te-orange"
            />
            <span className="text-sm text-te-grey-700">
              Number the files in playlist order
              <span className="text-xs text-te-grey-400 ml-2 font-te-mono">01 Track.mp3, 02 Other.aiff…</span>
            </span>
          </label>

          {scope && !running && !summary && (
            <div className="bg-te-grey-100 rounded-te p-te-sm text-sm font-te-mono space-y-1">
              {previewError ? (
                <div className="text-red-500">{previewError}</div>
              ) : previewing || !preview ? (
                <div className="text-te-grey-500">Checking the files…</div>
              ) : (
                <>
                  <div>
                    {preview.files} file{preview.files === 1 ? '' : 's'} — {formatFileSize(preview.totalSizeBytes)}
                  </div>
                  {preview.skipped.length > 0 && (
                    <details>
                      <summary className="cursor-pointer text-xs text-amber-600">
                        {preview.skipped.length} left out
                      </summary>
                      <ul className="mt-1 space-y-1 text-xs text-te-grey-500 max-h-32 overflow-auto">
                        {preview.skipped.map((s, i) => <li key={i}>{s.location || '(no location)'}: {s.reason}</li>)}
                      </ul>
                    </details>
                  )}
                </>
              )}
            </div>
          )}

          {running && progress && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-te-grey-500 font-te-mono">
                <span className="truncate max-w-xs">{progress.currentFile}</span>
                <span>
                  {progress.current} / {progress.total} — {formatFileSize(progress.bytesWritten)}
                  {' '}of {formatFileSize(progress.totalBytes)}
                </span>
              </div>
              <div className="w-full bg-te-grey-200 rounded-full h-2">
                <div className="bg-te-orange h-2 rounded-full transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}

          {summary && (
            <div className="bg-te-grey-100 rounded-te p-te-sm text-sm font-te-mono space-y-1">
              <div className="flex items-center gap-2 font-semibold text-te-grey-700">
                {summary.cancelled ? <X className="w-4 h-4 text-amber-500" /> : <CheckCircle className="w-4 h-4 text-green-600" />}
                {summary.cancelled ? 'Cancelled — no zip was left behind' : 'Exported'}
              </div>
              {!summary.cancelled && (
                <div className="break-all text-te-grey-600">
                  {summary.filesAdded} files, {formatFileSize(summary.bytes)} — {summary.outputPath}
                </div>
              )}
              {summary.skipped.length > 0 && (
                <div className="text-amber-600">{summary.skipped.length} left out (not on disk, or streaming)</div>
              )}
            </div>
          )}

          {error && <div className="text-sm text-red-500 font-te-mono">{error}</div>}

          <div className="flex gap-3 pt-1">
            {running ? (
              <button onClick={() => { void cancelPlaylistZip(); }} className="btn-secondary flex items-center gap-2">
                <X className="w-4 h-4" /> Cancel
              </button>
            ) : (
              <>
                <button
                  onClick={() => { void exportZip(); }}
                  disabled={!scope || previewing || !preview || preview.files === 0}
                  className="btn-primary flex items-center gap-2 disabled:opacity-40"
                >
                  <Archive className="w-4 h-4" /> Export ZIP…
                </button>
                {summary && !summary.cancelled && (
                  <button
                    onClick={() => { void window.electronAPI.showFileInFolder(summary.outputPath); }}
                    className="btn-secondary flex items-center gap-2"
                  >
                    <FolderOpen className="w-4 h-4" /> Show in folder
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
