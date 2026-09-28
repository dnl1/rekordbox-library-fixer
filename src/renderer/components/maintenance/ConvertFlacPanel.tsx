import React, { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, CheckCircle, Play, X } from 'lucide-react';
import { useAppContext } from '../../AppWithRouter';
import { useSettingsStore } from '../../stores/settingsStore';
import { formatFileSize } from '../../utils';
import { playlistScopes } from '../../utils/playlistScopes';
import {
  subscribeConversion, getConversionSnapshot, startConversion, cancelConversion, resetConversionSession,
} from '../../conversion/convertFlacSession';
import type { ConversionFormatPayload, ConvertFlacPreview } from '../../../main/ipcContract';
import { ActiveWorkers } from './shared';

type Phase = 'idle' | 'previewing' | 'previewed' | 'confirming' | 'running' | 'done';

const FORMATS: Array<{ value: ConversionFormatPayload; label: string; desc: string }> = [
  { value: 'aiff', label: 'AIFF', desc: 'Lossless, sample-exact. Keeps tags and artwork — the one to pick.' },
  { value: 'wav', label: 'WAV', desc: 'Lossless, sample-exact. Tags and artwork mostly do not survive.' },
  { value: 'mp3', label: 'MP3 320 kbps', desc: 'A quarter of the size. Lossy, and cues can land a few ms late.' },
];

/**
 * Convert the library's FLAC files for players that cannot read FLAC — older
 * CDJs and XDJs — and point every entry at the converted file, keeping its
 * cues, beatgrid and playlists.
 *
 * The originals stay unless asked otherwise, and even then go to the trash,
 * only once the library points at the conversion. The run itself lives in
 * `convertFlacSession`, so its progress and result survive this panel.
 */
export const ConvertFlacPanel: React.FC = () => {
  const { libraryData, libraryPath, showNotification, onLoadLibrary } = useAppContext();
  const session = useSyncExternalStore(subscribeConversion, getConversionSnapshot);
  const mine = session.libraryPath === libraryPath;

  const [format, setFormat] = useState<ConversionFormatPayload>(() => (mine && session.format) || 'aiff');
  const [trashOriginals, setTrashOriginals] = useState(false);
  const [localPhase, setLocalPhase] = useState<Phase>('idle');
  const [preview, setPreview] = useState<ConvertFlacPreview | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const running = mine && session.running;
  const summary = mine && !session.running ? session.summary : null;
  const progress = running ? session.progress : null;
  const phase: Phase = running ? 'running' : summary ? 'done' : localPhase;
  const error = localError ?? (mine && !session.running ? session.error : null);

  const isDatabase = libraryPath.toLowerCase().endsWith('.db');
  const tracks = useMemo(() => (libraryData ? Array.from(libraryData.tracks.values()) : []), [libraryData]);
  const scopes = useMemo(() => playlistScopes(libraryData?.playlists ?? []), [libraryData]);
  // '' is the whole library. A playlist is the usual case: what gets converted
  // is what is about to be exported to a USB stick.
  const [scopeKey, setScopeKey] = useState('');
  const scope = scopes.find((s) => s.key === scopeKey);
  const scopeTrackIds = scope?.trackIds;

  const reset = useCallback(() => {
    resetConversionSession();
    setLocalPhase('idle'); setPreview(null); setLocalError(null);
  }, []);

  /** Returns the preview so Convert can run one itself when none was asked for. */
  const runPreview = useCallback(async (): Promise<ConvertFlacPreview | null> => {
    resetConversionSession();
    setLocalPhase('previewing');
    setLocalError(null);
    const res = await window.electronAPI.convertFlacPreview({ tracks, format, scopeTrackIds });
    if (res.success && res.data) {
      setPreview(res.data);
      setLocalPhase('previewed');
      return res.data;
    }
    setLocalError(res.error ?? 'Preview failed');
    setLocalPhase('idle');
    return null;
  }, [tracks, format, scopeTrackIds]);

  // Convert used to stay greyed out until Preview had been pressed, which
  // nothing on screen said. It previews by itself now, then asks to confirm.
  const askToConvert = useCallback(async () => {
    const current = localPhase === 'previewed' ? preview : await runPreview();
    if (current?.available && current.files > 0) { setLocalPhase('confirming'); }
  }, [localPhase, preview, runPreview]);

  const runConvert = useCallback(async () => {
    if (isDatabase) {
      const { running: rekordboxOpen } = await window.electronAPI.isRekordboxRunning();
      if (rekordboxOpen) {
        showNotification('error', 'Close rekordbox first — the converted tracks are written into its database.');
        setLocalPhase('previewed');
        return;
      }
    }
    setLocalError(null);
    setLocalPhase('previewed');

    // Everything after this await may run with the panel unmounted — the
    // library reload below replaces the page — so it touches no local state.
    const res = await startConversion({
      tracks,
      scopeTrackIds,
      libraryPath,
      dbKey: isDatabase ? useSettingsStore.getState().rekordboxDbKey : undefined,
      format,
      trashOriginals: trashOriginals && isDatabase,
      workers: useSettingsStore.getState().workers,
    });

    if (!res.success || !res.data) {
      showNotification('error', res.error ?? 'Conversion failed', { important: true });
      return;
    }
    const s = res.data;
    showNotification(
      s.failed.length > 0 ? 'warning' : 'success',
      `${s.cancelled ? 'Cancelled. ' : ''}Converted ${s.filesConverted} file${s.filesConverted === 1 ? '' : 's'}`
      + ` and updated ${s.tracksUpdated} entr${s.tracksUpdated === 1 ? 'y' : 'ies'}`
      + `${isDatabase ? ' in the rekordbox database.' : '.'}`
      + `${s.failed.length > 0 ? ` ${s.failed.length} failed.` : ''}`
      + `${s.trashed.length > 0 ? ` ${s.trashed.length} originals moved to the trash.` : ''}`
      + `${s.backupPath ? '\nA backup was saved first — undo from the Backups tab.' : ''}`,
      { important: true }
    );
    if (s.tracksUpdated > 0) { onLoadLibrary?.(libraryPath); }
  }, [isDatabase, tracks, scopeTrackIds, libraryPath, format, trashOriginals, showNotification, onLoadLibrary]);

  const cancel = useCallback(() => { void cancelConversion(); }, []);

  const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
  const nothingToDo = preview !== null && preview.files === 0;

  return (
    <div className="bg-white rounded-te shadow-sm p-te-md mt-te-md">
      <h3 className="font-semibold text-te-grey-800 mb-1">Convert FLAC</h3>
      <p className="text-sm text-te-grey-500 font-te-mono mb-te-md">
        Older CDJs and XDJs cannot play FLAC. This converts each FLAC to a file beside it and points
        the library at it — cues, beatgrid and playlists stay with the track.
      </p>

      {!libraryData ? (
        <p className="text-sm text-te-grey-400 italic">Load a library first to convert.</p>
      ) : (
        <div className="space-y-te-md">
          <div>
            <label htmlFor="convert-scope" className="block text-xs font-medium text-te-grey-600 mb-1 uppercase">Convert</label>
            <select
              id="convert-scope"
              value={scopeKey}
              disabled={phase === 'running'}
              onChange={(e) => { setScopeKey(e.target.value); reset(); }}
              className="w-full border border-te-grey-300 rounded-te px-3 py-2 text-sm font-te-mono bg-te-cream focus:outline-none focus:border-te-orange"
            >
              <option value="">The whole library</option>
              {scopes.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.isFolder ? 'Folder' : 'Playlist'}: {s.label} ({s.trackIds.length})
                </option>
              ))}
            </select>
            <p className="text-xs font-te-mono text-te-grey-400 mt-1">
              Converting before a USB export? Pick the playlist you are exporting, then export it from
              rekordbox as usual — it copies the converted files.
            </p>
          </div>

          <fieldset disabled={phase === 'running'}>
            <legend className="block text-xs font-medium text-te-grey-600 mb-2 uppercase">Convert to</legend>
            <div className="flex flex-col gap-2">
              {FORMATS.map((opt) => (
                <label key={opt.value} htmlFor={`convert-format-${opt.value}`} className="flex items-start gap-2 cursor-pointer">
                  <input
                    id={`convert-format-${opt.value}`}
                    type="radio"
                    name="convert-format"
                    value={opt.value}
                    checked={format === opt.value}
                    onChange={() => { setFormat(opt.value); reset(); }}
                    className="mt-0.5 text-te-orange"
                  />
                  <span className="text-sm font-medium text-te-grey-800">
                    {opt.label}
                    <span className="text-xs font-normal text-te-grey-400 ml-2 font-te-mono">{opt.desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div>
            <label htmlFor="convert-trash-originals" className="flex items-center gap-2 cursor-pointer">
              <input
                id="convert-trash-originals"
                type="checkbox"
                checked={trashOriginals && isDatabase}
                disabled={phase === 'running' || !isDatabase}
                onChange={(e) => setTrashOriginals(e.target.checked)}
                className="accent-te-orange"
              />
              <span className="text-sm text-te-grey-700">Move the FLAC originals to the trash afterwards</span>
            </label>
            {!isDatabase && (
              <p className="text-xs font-te-mono text-te-grey-400 mt-1 ml-6">
                Only when converting rekordbox&apos;s own database: after an XML conversion, rekordbox still
                points at the FLACs.
              </p>
            )}
            {trashOriginals && isDatabase && format === 'mp3' && (
              <p className="text-xs font-te-mono text-te-amber-600 mt-1 ml-6">
                <AlertTriangle size={12} className="inline mr-1" />
                MP3 is lossy: once the trash is emptied, the FLAC was the only lossless copy.
              </p>
            )}
          </div>

          {!isDatabase && (
            <p className="text-xs font-te-mono text-te-grey-500">
              This library is an XML export. Importing it into rekordbox adds the converted files as new
              tracks next to the FLACs rather than replacing them — open rekordbox&apos;s database here
              instead to convert in place.
            </p>
          )}

          {preview && phase !== 'idle' && phase !== 'previewing' && (
            <div className="bg-te-grey-100 rounded-te p-te-sm text-sm font-te-mono space-y-1">
              {!preview.available ? (
                <div className="text-red-500">This build of the app has no ffmpeg for this platform.</div>
              ) : (
                <>
                  <div>
                    {preview.files} FLAC file{preview.files === 1 ? '' : 's'} to convert{scope ? ` in ${scope.label}` : ''}
                    {' '}— {formatFileSize(preview.totalSizeBytes)}, {preview.flacTracks} entr{preview.flacTracks === 1 ? 'y' : 'ies'}
                  </div>
                  {preview.reusable > 0 && (
                    <div className="text-te-grey-600">
                      {preview.reusable} already have a .{format} from an earlier run — each is checked
                      against its FLAC and used as it is if identical, left alone if not
                    </div>
                  )}
                  {nothingToDo && (
                    <div className="text-te-grey-600">Nothing to convert here.</div>
                  )}
                  {preview.conflicts > 0 && (
                    <div className="text-amber-600">
                      {preview.conflicts} already have a .{format} beside them — those are left alone
                    </div>
                  )}
                  {preview.missing > 0 && (
                    <div className="text-te-grey-400">{preview.missing} FLAC files not found (will be skipped)</div>
                  )}
                </>
              )}
            </div>
          )}

          {phase === 'confirming' && (
            <p className="text-xs font-te-mono text-te-grey-700">
              Converts {preview?.files} files and re-points their entries. Nothing is overwritten, and
              {trashOriginals && isDatabase ? ' each original goes to the trash only once the library points at its conversion.' : ' the originals are kept.'}
              {isDatabase ? ' This is written into the rekordbox database, so rekordbox must stay closed.' : ''}
              {' '}A backup is saved first, and you can undo the library change from the Backups tab.
            </p>
          )}

          {phase === 'running' && progress && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-te-grey-500 font-te-mono">
                <span className="truncate max-w-xs">{progress.currentFile}</span>
                <span>{progress.current} / {progress.total}</span>
              </div>
              <div className="w-full bg-te-grey-200 rounded-full h-2">
                <div className="bg-te-orange h-2 rounded-full transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="flex gap-4 text-xs font-te-mono text-te-grey-500">
                <span className="text-green-600">{progress.converted} converted</span>
                <span className="text-te-grey-400">{progress.skipped} skipped</span>
                {progress.failed > 0 && <span className="text-red-500">{progress.failed} failed</span>}
                <ActiveWorkers active={progress.active} />
              </div>
            </div>
          )}

          {phase === 'done' && summary && (
            <div className="bg-te-grey-100 rounded-te p-te-sm text-sm font-te-mono space-y-1">
              <div className="flex items-center gap-2 font-semibold text-te-grey-700">
                {summary.cancelled ? <X className="w-4 h-4 text-amber-500" /> : <CheckCircle className="w-4 h-4 text-green-600" />}
                {summary.cancelled ? 'Cancelled — what finished was kept' : 'Complete'}
              </div>
              <div className="flex flex-wrap gap-4">
                <span className="text-green-600">{summary.filesConverted} converted</span>
                <span>{summary.tracksUpdated} entries updated</span>
                <span className="text-te-grey-400">{summary.skipped.length} skipped</span>
                {summary.failed.length > 0 && <span className="text-red-500">{summary.failed.length} failed</span>}
                {summary.trashed.length > 0 && <span>{summary.trashed.length} originals trashed</span>}
              </div>
              {[...summary.failed.map((f) => `${f.file}: ${f.error}`),
                ...summary.skipped.map((s) => `${s.location ?? s.trackId}: ${s.reason}`),
                ...summary.trashFailed.map((f) => `${f.file}: not trashed — ${f.error}`)].length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs">Show details</summary>
                  <ul className="mt-1 space-y-1 text-xs text-te-grey-500 max-h-32 overflow-auto">
                    {summary.failed.map((f, i) => <li key={`f${i}`} className="text-red-400">{f.file}: {f.error}</li>)}
                    {summary.skipped.map((s, i) => <li key={`s${i}`}>{s.location ?? s.trackId}: {s.reason}</li>)}
                    {summary.trashFailed.map((f, i) => <li key={`t${i}`}>{f.file}: not trashed — {f.error}</li>)}
                  </ul>
                </details>
              )}
            </div>
          )}

          {error && <div className="text-sm text-red-500 font-te-mono">{error}</div>}

          <div className="flex gap-3 pt-1">
            {phase === 'running' ? (
              <button onClick={cancel} className="btn-secondary flex items-center gap-2">
                <X className="w-4 h-4" /> Cancel
              </button>
            ) : phase === 'confirming' ? (
              <>
                <button onClick={runConvert} className="btn-primary flex items-center gap-2">
                  <Play className="w-4 h-4" /> Convert {preview?.files} files
                </button>
                <button onClick={() => setLocalPhase('previewed')} className="btn-ghost">Back</button>
              </>
            ) : (
              <>
                <button
                  onClick={() => { void runPreview(); }}
                  disabled={phase === 'previewing'}
                  className="btn-secondary flex items-center gap-2 disabled:opacity-40"
                >
                  {phase === 'previewing' ? 'Checking…' : 'Preview'}
                </button>
                <button
                  onClick={askToConvert}
                  disabled={phase === 'previewing' || (phase === 'previewed' && (!preview?.available || nothingToDo))}
                  className="btn-primary flex items-center gap-2 disabled:opacity-40"
                >
                  <Play className="w-4 h-4" /> Convert
                </button>
                {phase === 'done' && <button onClick={reset} className="btn-secondary">Reset</button>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
