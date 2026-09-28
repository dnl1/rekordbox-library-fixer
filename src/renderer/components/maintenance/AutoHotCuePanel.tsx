import React, { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { CheckCircle, Play, Sparkles, X } from 'lucide-react';
import { useAppContext } from '../../AppWithRouter';
import { useSettingsStore } from '../../stores/settingsStore';
import { playlistScopes } from '../../utils/playlistScopes';
import { audioController } from '../../audio/audioController';
import {
  subscribeHotCues, getHotCueSnapshot, startHotCueSuggestions, cancelHotCueSuggestions, resetHotCueSession,
} from '../../hotcues/autoHotCueSession';
import type { AutoHotCueTrack } from '../../../main/ipcContract';
import { ActiveWorkers } from './shared';

type Phase = 'idle' | 'suggesting' | 'suggested' | 'writing';

const LETTERS = 'ABCDEFGH';

/** `1:23.4` — tenths, because a cue a beat off is a tenth of a second off at 140 BPM. */
export const formatCueTime = (ms: number): string => {
  const tenths = Math.round(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = ((tenths % 600) / 10).toFixed(1).padStart(4, '0');
  return `${minutes}:${seconds}`;
};

/**
 * Hot cues from rekordbox's own phrase analysis and the drops in each track's
 * bass, for tracks that have none: one per section — Intro, Up, Drop, Down,
 * Outro — on A to H. Each track can be listened to at its cues and unticked
 * before anything is written. The rules live in `src/main/autoHotCue.ts` and
 * `bassDrops.ts`, the write in `rekordboxDbHotCues.ts`, the suggestion run —
 * minutes long — in `autoHotCueSession`.
 */
export const AutoHotCuePanel: React.FC = () => {
  const { libraryData, libraryPath, showNotification, onLoadLibrary } = useAppContext();
  const isDatabase = libraryPath.toLowerCase().endsWith('.db');
  const scopes = useMemo(() => playlistScopes(libraryData?.playlists ?? []), [libraryData]);

  const session = useSyncExternalStore(subscribeHotCues, getHotCueSnapshot);
  const mine = session.libraryPath === libraryPath;
  const [scopeKey, setScopeKey] = useState('');
  const [beatsBefore, setBeatsBefore] = useState(0);
  const [writing, setWriting] = useState(false);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());

  const preview = mine && !session.running ? session.preview : null;
  const progress = mine && session.running ? session.progress : null;
  const error = mine && !session.running ? session.error : null;
  const phase: Phase = writing ? 'writing' : mine && session.running ? 'suggesting' : preview ? 'suggested' : 'idle';

  const scope = scopes.find((s) => s.key === scopeKey);
  const chosen = useMemo(
    () => (preview ? preview.tracks.filter((t) => !unticked.has(t.trackId)) : []),
    [preview, unticked]
  );

  const reset = useCallback(() => { resetHotCueSession(); setUnticked(new Set()); }, []);

  const runPreview = useCallback(async () => {
    setUnticked(new Set());
    const { rekordboxDbKey, workers } = useSettingsStore.getState();
    await startHotCueSuggestions({
      libraryPath, dbKey: rekordboxDbKey, scopeTrackIds: scope?.trackIds, beatsBefore, workers,
    });
  }, [libraryPath, scope, beatsBefore]);

  const runWrite = useCallback(async () => {
    const { running } = await window.electronAPI.isRekordboxRunning();
    if (running) {
      showNotification('error', 'Close rekordbox first — the hot cues are written into its database.');
      return;
    }
    setWriting(true);
    const res = await window.electronAPI.autoHotCueWrite({
      libraryPath,
      dbKey: useSettingsStore.getState().rekordboxDbKey,
      tracks: chosen.map((t) => ({
        trackId: t.trackId,
        cues: t.cues.map(({ kind, name, ms }) => ({ kind, name, ms })),
      })),
    });
    setWriting(false);
    if (!res.success || !res.data) {
      showNotification('error', res.error ?? 'The hot cues could not be written', { important: true });
      return;
    }
    const s = res.data;
    showNotification(
      'success',
      `Added ${s.cuesWritten} hot cue${s.cuesWritten === 1 ? '' : 's'} to ${s.tracksWritten} track${s.tracksWritten === 1 ? '' : 's'}.`
      + `${s.skipped.length > 0 ? ` ${s.skipped.length} left alone — ${s.skipped[0].reason}${s.skipped.length > 1 ? ', …' : ''}.` : ''}`
      + '\nA backup was saved first — undo from the Backups tab.',
      { important: true }
    );
    reset();
    // The page is replaced while the library reloads, so nothing local is touched after this.
    if (s.tracksWritten > 0) { onLoadLibrary?.(libraryPath); }
  }, [libraryPath, chosen, showNotification, reset, onLoadLibrary]);

  const toggle = (id: string) => setUnticked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) { next.delete(id); } else { next.add(id); }
    return next;
  });

  const listen = (track: AutoHotCueTrack, ms: number) => {
    const player = { id: track.trackId, name: track.title, artist: track.artist, location: track.location };
    void audioController.playTrack(player, ms / 1000);
  };

  return (
    <div className="bg-white rounded-te shadow-sm p-te-md mt-te-md">
      <h3 className="font-semibold text-te-grey-800 mb-1">Auto hot cues</h3>
      <p className="text-sm text-te-grey-500 font-te-mono mb-te-md">
        Puts a hot cue at the start of each section rekordbox found — Intro, Up, Drop, Down, Outro — on
        tracks with no hot cue at all. Memory cues stay as they are.
      </p>

      {!libraryData ? (
        <p className="text-sm text-te-grey-400 italic">Load a library first.</p>
      ) : !isDatabase ? (
        <p className="text-xs font-te-mono text-te-grey-500">
          Only for rekordbox&apos;s own database: the phrase analysis is read from the files beside master.db.
        </p>
      ) : (
        <div className="space-y-te-md">
          <div className="grid gap-te-md sm:grid-cols-2">
            <div>
              <label htmlFor="hotcue-scope" className="block text-xs font-medium text-te-grey-600 mb-1 uppercase">Tracks</label>
              <select
                id="hotcue-scope"
                value={scopeKey}
                disabled={phase === 'writing' || phase === 'suggesting'}
                onChange={(e) => { setScopeKey(e.target.value); reset(); }}
                className="w-full border border-te-grey-300 rounded-te px-3 py-2 text-sm font-te-mono bg-te-cream focus:outline-none focus:border-te-orange"
              >
                <option value="">The whole collection</option>
                {scopes.map((s) => (
                  <option key={s.key} value={s.key}>{s.isFolder ? 'Folder' : 'Playlist'}: {s.label} ({s.trackIds.length})</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="hotcue-offset" className="block text-xs font-medium text-te-grey-600 mb-1 uppercase">Place each cue</label>
              <select
                id="hotcue-offset"
                value={beatsBefore}
                disabled={phase === 'writing' || phase === 'suggesting'}
                onChange={(e) => { setBeatsBefore(Number(e.target.value)); reset(); }}
                className="w-full border border-te-grey-300 rounded-te px-3 py-2 text-sm font-te-mono bg-te-cream focus:outline-none focus:border-te-orange"
              >
                <option value={0}>On the phrase</option>
                <option value={4}>One bar before the phrase</option>
              </select>
            </div>
          </div>

          {preview && (
            <div className="bg-te-grey-100 rounded-te p-te-sm text-sm font-te-mono space-y-1">
              <div>
                {preview.tracks.length} track{preview.tracks.length === 1 ? '' : 's'} to cue{scope ? ` in ${scope.label}` : ''}
                {' '}— {chosen.length} ticked
              </div>
              {preview.alreadyCued > 0 && (
                <div className="text-te-grey-600">{preview.alreadyCued} already have hot cues — left alone</div>
              )}
              {preview.notAnalysed > 0 && (
                <div className="text-te-grey-400">
                  {preview.notAnalysed} have no phrase analysis or beatgrid — analyse them in rekordbox first
                </div>
              )}
              {preview.withoutDrops > 0 && (
                <div className="text-amber-600">
                  {preview.withoutDrops} could not be listened to for drops — their cues follow the phrases alone
                </div>
              )}
              {preview.cancelled && <div className="text-amber-600">Stopped early — only the tracks done so far</div>}
            </div>
          )}

          {phase === 'suggesting' && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-te-grey-500 font-te-mono">
                <span className="truncate max-w-xs">Listening for drops{progress ? ` — ${progress.currentFile}` : '…'}</span>
                {progress && <span>{progress.current} / {progress.total}</span>}
              </div>
              <div className="w-full bg-te-grey-200 rounded-full h-2">
                <div
                  className="bg-te-orange h-2 rounded-full transition-all"
                  style={{ width: `${progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0}%` }}
                />
              </div>
              {progress && <div className="text-xs font-te-mono"><ActiveWorkers active={progress.active} /></div>}
            </div>
          )}

          {preview && preview.tracks.length > 0 && (
            <ul className="border border-te-grey-200 rounded-te divide-y divide-te-grey-100 max-h-96 overflow-auto">
              {preview.tracks.map((track) => (
                <li key={track.trackId} className="p-te-sm">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!unticked.has(track.trackId)}
                      onChange={() => toggle(track.trackId)}
                      aria-label={`Cue ${track.title}`}
                      className="accent-te-orange"
                    />
                    <span className="text-sm text-te-grey-800 truncate">
                      {track.artist ? `${track.artist} — ` : ''}{track.title}
                    </span>
                  </label>
                  <div className="flex flex-wrap gap-1 mt-1 ml-6">
                    {track.cues.map((cue) => (
                      <button
                        key={cue.slot}
                        onClick={() => listen(track, cue.ms)}
                        title={`Listen from ${formatCueTime(cue.ms)}`}
                        className="text-xs font-te-mono px-2 py-0.5 rounded bg-te-grey-100 hover:bg-te-orange hover:text-white"
                      >
                        {LETTERS[cue.slot]} {cue.name} {formatCueTime(cue.ms)}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {phase === 'suggested' && chosen.length > 0 && (
            <p className="text-xs font-te-mono text-te-grey-700">
              Writes the cues into the rekordbox database, so rekordbox must be closed. Each track is checked
              again first, and one that got a hot cue meanwhile is left alone. A backup is saved first, and you
              can undo from the Backups tab.
            </p>
          )}

          {error && <div className="text-sm text-red-500 font-te-mono">{error}</div>}

          <div className="flex gap-3 pt-1">
            {phase === 'suggesting' ? (
              <button onClick={() => { void cancelHotCueSuggestions(); }} className="btn-secondary flex items-center gap-2">
                <X className="w-4 h-4" /> Cancel
              </button>
            ) : (
              <button
                onClick={() => { void runPreview(); }}
                disabled={phase === 'writing'}
                className="btn-secondary flex items-center gap-2 disabled:opacity-40"
              >
                <Sparkles className="w-4 h-4" /> Suggest hot cues
              </button>
            )}
            {preview && chosen.length > 0 && (
              <button
                onClick={() => { void runWrite(); }}
                disabled={phase === 'writing'}
                className="btn-primary flex items-center gap-2 disabled:opacity-40"
              >
                {phase === 'writing' ? <CheckCircle className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                {phase === 'writing' ? 'Writing…' : `Add hot cues to ${chosen.length} tracks`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
