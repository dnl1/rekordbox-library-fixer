import React, { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { CheckCircle, Trash2, X } from 'lucide-react';
import { useAppContext } from '../../AppWithRouter';
import { useSettingsStore } from '../../stores/settingsStore';
import { formatFileSize } from '../../utils';
import {
  subscribeCleanup, getCleanupSnapshot, startCleanup, cancelCleanup, resetCleanupSession,
} from '../../conversion/flacCleanupSession';
import type { FlacCleanupPreview } from '../../../main/ipcContract';
import { ActiveWorkers } from './shared';

type Phase = 'idle' | 'previewing' | 'previewed' | 'confirming' | 'running' | 'done';

/**
 * Trash the FLACs a conversion left behind: no entry uses them, an entry uses
 * the AIFF or WAV beside them, and the two decode to the same audio. The rules
 * live in `src/main/flacCleanup.ts`; the run in `flacCleanupSession`.
 */
export const CleanupFlacPanel: React.FC = () => {
  const { libraryData, libraryPath, showNotification } = useAppContext();
  const session = useSyncExternalStore(subscribeCleanup, getCleanupSnapshot);
  const mine = session.libraryPath === libraryPath;

  const [localPhase, setLocalPhase] = useState<Phase>('idle');
  const [preview, setPreview] = useState<FlacCleanupPreview | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const running = mine && session.running;
  const summary = mine && !session.running ? session.summary : null;
  const progress = running ? session.progress : null;
  const phase: Phase = running ? 'running' : summary ? 'done' : localPhase;
  const error = localError ?? (mine && !session.running ? session.error : null);

  const isDatabase = libraryPath.toLowerCase().endsWith('.db');
  const tracks = useMemo(() => (libraryData ? Array.from(libraryData.tracks.values()) : []), [libraryData]);

  const reset = useCallback(() => {
    resetCleanupSession();
    setLocalPhase('idle'); setPreview(null); setLocalError(null);
  }, []);

  const runPreview = useCallback(async () => {
    resetCleanupSession();
    setLocalPhase('previewing');
    setLocalError(null);
    const res = await window.electronAPI.cleanupFlacPreview({ tracks });
    if (res.success && res.data) {
      setPreview(res.data);
      setLocalPhase(res.data.available && res.data.files > 0 ? 'confirming' : 'previewed');
      return;
    }
    setLocalError(res.error ?? 'Preview failed');
    setLocalPhase('idle');
  }, [tracks]);

  const runCleanup = useCallback(async () => {
    setLocalError(null);
    setLocalPhase('previewed');
    const res = await startCleanup({
      tracks,
      libraryPath,
      dbKey: useSettingsStore.getState().rekordboxDbKey,
      workers: useSettingsStore.getState().workers,
    });
    if (!res.success || !res.data) {
      showNotification('error', res.error ?? 'Cleanup failed', { important: true });
      return;
    }
    const s = res.data;
    showNotification(
      s.failed.length > 0 ? 'warning' : 'success',
      `${s.cancelled ? 'Cancelled — nothing was trashed. ' : ''}`
      + `Moved ${s.trashed.length} FLAC${s.trashed.length === 1 ? '' : 's'} to the trash, freeing ${formatFileSize(s.freedBytes)}.`
      + `${s.kept.length > 0 ? ` ${s.kept.length} kept.` : ''}`
      + `${s.failed.length > 0 ? ` ${s.failed.length} failed.` : ''}`,
      { important: true }
    );
  }, [tracks, libraryPath, showNotification]);

  const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div className="bg-white rounded-te shadow-sm p-te-md mt-te-md">
      <h3 className="font-semibold text-te-grey-800 mb-1">Clean up converted FLACs</h3>
      <p className="text-sm text-te-grey-500 font-te-mono mb-te-md">
        Moves to the trash each FLAC that no entry uses any more, when the AIFF or WAV beside it is in the
        library and decodes to exactly the same audio.
      </p>

      {!libraryData ? (
        <p className="text-sm text-te-grey-400 italic">Load a library first to clean up.</p>
      ) : !isDatabase ? (
        <p className="text-xs font-te-mono text-te-grey-500">
          Only for rekordbox&apos;s own database: an XML library does not say which files rekordbox itself
          still uses, and its collection may still point at the FLACs.
        </p>
      ) : (
        <div className="space-y-te-md">
          {preview && phase !== 'idle' && phase !== 'previewing' && (
            <div className="bg-te-grey-100 rounded-te p-te-sm text-sm font-te-mono space-y-1">
              {!preview.available ? (
                <div className="text-red-500">This build of the app has no ffmpeg for this platform.</div>
              ) : (
                <>
                  <div>
                    {preview.files} FLAC file{preview.files === 1 ? '' : 's'} beside a conversion no entry uses
                    {' '}— {formatFileSize(preview.totalSizeBytes)}
                  </div>
                  {preview.files === 0 && <div className="text-te-grey-600">Nothing to clean up.</div>}
                  {preview.stillUsed > 0 && (
                    <div className="text-te-grey-600">
                      {preview.stillUsed} more still have an entry pointing at them — Convert FLAC with
                      &quot;Move the FLAC originals to the trash&quot; ticked re-points those entries and trashes them
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {phase === 'confirming' && (
            <p className="text-xs font-te-mono text-te-grey-700">
              Each FLAC is decoded and compared with its AIFF or WAV first; only an exact match goes, and only
              to the trash. What rekordbox points at is read again just before, so rekordbox may stay open.
              Nothing is written into the database.
            </p>
          )}

          {phase === 'running' && progress && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-te-grey-500 font-te-mono">
                <span className="truncate max-w-xs">Comparing {progress.currentFile}</span>
                <span>{progress.current} / {progress.total}</span>
              </div>
              <div className="w-full bg-te-grey-200 rounded-full h-2">
                <div className="bg-te-orange h-2 rounded-full transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="text-xs font-te-mono"><ActiveWorkers active={progress.active} /></div>
            </div>
          )}

          {phase === 'done' && summary && (
            <div className="bg-te-grey-100 rounded-te p-te-sm text-sm font-te-mono space-y-1">
              <div className="flex items-center gap-2 font-semibold text-te-grey-700">
                {summary.cancelled ? <X className="w-4 h-4 text-amber-500" /> : <CheckCircle className="w-4 h-4 text-green-600" />}
                {summary.cancelled ? 'Cancelled — nothing was trashed' : 'Complete'}
              </div>
              <div className="flex flex-wrap gap-4">
                <span className="text-green-600">{summary.trashed.length} trashed</span>
                <span>{formatFileSize(summary.freedBytes)} freed</span>
                <span className="text-te-grey-400">{summary.kept.length} kept</span>
                {summary.failed.length > 0 && <span className="text-red-500">{summary.failed.length} failed</span>}
              </div>
              {summary.kept.length + summary.failed.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs">Show details</summary>
                  <ul className="mt-1 space-y-1 text-xs text-te-grey-500 max-h-32 overflow-auto">
                    {summary.failed.map((f, i) => <li key={`f${i}`} className="text-red-400">{f.file}: {f.error}</li>)}
                    {summary.kept.map((k, i) => <li key={`k${i}`}>{k.file}: {k.reason}</li>)}
                  </ul>
                </details>
              )}
            </div>
          )}

          {error && <div className="text-sm text-red-500 font-te-mono">{error}</div>}

          <div className="flex gap-3 pt-1">
            {phase === 'running' ? (
              <button onClick={() => { void cancelCleanup(); }} className="btn-secondary flex items-center gap-2">
                <X className="w-4 h-4" /> Cancel
              </button>
            ) : phase === 'confirming' ? (
              <>
                <button onClick={runCleanup} className="btn-primary flex items-center gap-2">
                  <Trash2 className="w-4 h-4" /> Check and trash {preview?.files} FLACs
                </button>
                <button onClick={reset} className="btn-ghost">Back</button>
              </>
            ) : (
              <>
                <button
                  onClick={() => { void runPreview(); }}
                  disabled={phase === 'previewing'}
                  className="btn-secondary flex items-center gap-2 disabled:opacity-40"
                >
                  {phase === 'previewing' ? 'Checking…' : 'Find leftover FLACs'}
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
