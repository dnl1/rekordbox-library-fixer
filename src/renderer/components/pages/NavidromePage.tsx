import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle, Download, FolderOpen, ListMusic, Search, Server, X } from 'lucide-react';
import { useAppContext } from '../../AppWithRouter';
import { useSettingsStore } from '../../stores/settingsStore';
import { PageHeader } from '../ui';
import { fileTypeFor } from '../../../main/navidrome/fileTypes';
import type {
  NavidromeConnectionInfo, NavidromeImportProgress, NavidromeImportSummary, NavidromePlaylist, NavidromeSong,
} from '../../../main/ipcContract';

type Tab = 'playlists' | 'search';

/** `1:02:03` or `4:05`. */
export const formatDuration = (seconds: number | undefined): string => {
  if (!seconds || seconds < 0) { return '—'; }
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

const PHASE_TEXT: Record<NavidromeImportProgress['phase'], string> = {
  listing: 'Asking the server what to fetch…',
  downloading: 'Downloading',
  writing: "Writing into rekordbox's database…",
};

/**
 * Tracks and playlists from a Navidrome server, into rekordbox: pick
 * playlists or search for songs, and the original files are downloaded and
 * added to rekordbox's own database — playlists as playlists, in order.
 * rekordbox analyses them itself the first time it sees them.
 */
export const NavidromePage: React.FC = () => {
  const { libraryPath, showNotification, onLoadLibrary, onOpenSettings } = useAppContext();
  const isDatabase = libraryPath.toLowerCase().endsWith('.db');

  const [connection, setConnection] = useState<NavidromeConnectionInfo | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('playlists');
  const [playlists, setPlaylists] = useState<NavidromePlaylist[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NavidromeSong[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [pickedPlaylists, setPickedPlaylists] = useState<Set<string>>(new Set());
  const [pickedSongs, setPickedSongs] = useState<Map<string, NavidromeSong>>(new Map());

  const destination = useSettingsStore((s) => s.navidromeDestination);
  const setDestination = useSettingsStore((s) => s.setNavidromeDestination);
  const [defaultDestination, setDefaultDestination] = useState('');
  const target = destination.trim() ? destination : defaultDestination;

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<NavidromeImportProgress | null>(null);
  const [summary, setSummary] = useState<NavidromeImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operationRef = useRef('');

  useEffect(() => {
    let active = true;
    window.electronAPI.navidromeConnection().then((res) => {
      if (active) { setConnection(res.success ? res.data ?? null : null); }
    }).catch(() => { if (active) { setConnection(null); } });
    window.electronAPI.navidromeDefaultDestination().then((res) => {
      if (active && res.success && res.data) { setDefaultDestination(res.data); }
    }).catch(() => { /* the field then waits for a folder */ });
    return () => { active = false; };
  }, []);

  const loadPlaylists = useCallback(async () => {
    setListError(null);
    const res = await window.electronAPI.navidromePlaylists();
    if (res.success) { setPlaylists(res.data ?? []); } else { setListError(res.error ?? 'Could not list the playlists.'); }
  }, []);

  useEffect(() => { if (connection) { void loadPlaylists(); } }, [connection, loadPlaylists]);

  useEffect(() => window.electronAPI.onNavidromeImportProgress((p) => {
    if (p.operationId === operationRef.current) { setProgress(p); }
  }), []);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) { return; }
    setSearching(true);
    setListError(null);
    const res = await window.electronAPI.navidromeSearch(query);
    setSearching(false);
    if (res.success) { setResults(res.data ?? []); } else { setListError(res.error ?? 'The search failed.'); }
  };

  const togglePlaylist = (id: string) => setPickedPlaylists((prev) => {
    const next = new Set(prev);
    if (next.has(id)) { next.delete(id); } else { next.add(id); }
    return next;
  });
  const toggleSong = (song: NavidromeSong) => setPickedSongs((prev) => {
    const next = new Map(prev);
    if (next.has(song.id)) { next.delete(song.id); } else { next.set(song.id, song); }
    return next;
  });

  const pickedSongCount = useMemo(
    () => (playlists ?? [])
      .filter((p) => pickedPlaylists.has(p.id))
      .reduce((n, p) => n + p.songCount, 0) + pickedSongs.size,
    [playlists, pickedPlaylists, pickedSongs],
  );
  const nothingPicked = pickedPlaylists.size === 0 && pickedSongs.size === 0;
  const blocked = !isDatabase
    ? "Open rekordbox's database in the Library tab to import — the tracks are written into master.db."
    : !target ? 'Choose the folder the tracks are downloaded to.' : null;

  const pickFolder = async () => {
    const folder = await window.electronAPI.selectFolder();
    if (folder) { setDestination(folder); }
  };

  const runImport = async () => {
    const { running: rekordboxOpen } = await window.electronAPI.isRekordboxRunning();
    if (rekordboxOpen) {
      showNotification('error', 'Close rekordbox first — the tracks are written into its database.');
      return;
    }
    const operationId = `navidrome-${Date.now()}`;
    operationRef.current = operationId;
    setRunning(true); setSummary(null); setError(null); setProgress(null);
    const res = await window.electronAPI.navidromeImport({
      operationId,
      libraryPath,
      dbKey: useSettingsStore.getState().rekordboxDbKey,
      destination: target,
      playlistIds: [...pickedPlaylists],
      songIds: [...pickedSongs.keys()],
    });
    setRunning(false); setProgress(null);
    if (!res.success || !res.data) { setError(res.error ?? 'The import failed.'); return; }
    const s = res.data;
    setSummary(s);
    if (!s.cancelled && (s.tracksAdded > 0 || s.playlists.length > 0)) {
      setPickedPlaylists(new Set()); setPickedSongs(new Map());
      showNotification('success', `Imported ${plural(s.tracksAdded, 'track')}${s.playlists.length ? ` and ${plural(s.playlists.length, 'playlist')}` : ''} into rekordbox.`, { important: true });
    }
  };

  const cancel = async () => { await window.electronAPI.cancelNavidromeImport(operationRef.current); };

  if (connection === undefined) {
    return <div className="flex-1 flex flex-col"><PageHeader icon={Server} title="Navidrome" /></div>;
  }

  if (connection === null) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <PageHeader icon={Server} title="Navidrome" />
        <div className="text-center mt-10 te-value max-w-sm mx-auto px-6">
          <Server size={44} className="mx-auto mb-3 text-te-grey-400" />
          <h3 className="te-title mb-2">No server yet</h3>
          <p className="te-label normal-case mb-4">Type your Navidrome address, username and password in Settings, then come back here.</p>
          <button onClick={() => onOpenSettings?.('navidrome')} className="btn-primary text-xs">Set up Navidrome</button>
        </div>
      </div>
    );
  }

  const songRow = (song: NavidromeSong) => {
    const playable = fileTypeFor(song.suffix) !== undefined;
    return (
      <label key={song.id} className={`flex items-center gap-3 px-3 py-2 border-b border-te-grey-200 text-xs ${playable ? 'cursor-pointer hover:bg-te-grey-100' : 'opacity-50'}`}>
        <input type="checkbox" disabled={!playable || running} checked={pickedSongs.has(song.id)} onChange={() => toggleSong(song)} aria-label={`${song.artist} — ${song.title}`} />
        <span className="flex-1 min-w-0">
          <span className="te-value block truncate">{song.artist ? `${song.artist} — ` : ''}{song.title}</span>
          <span className="te-label normal-case truncate block">{song.album}</span>
        </span>
        <span className="te-label w-14 text-right">{(song.suffix || '?').toUpperCase()}</span>
        <span className="te-label w-12 text-right">{formatDuration(song.duration)}</span>
        {!playable && <span className="te-label normal-case text-te-red-500">rekordbox cannot play this</span>}
      </label>
    );
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        icon={Server}
        title="Navidrome"
        stats={`${connection.username} @ ${hostOf(connection.url)}`}
        actions={<button onClick={() => onOpenSettings?.('navidrome')} className="btn-ghost text-xs">Connection</button>}
      />

      <div role="tablist" className="px-4 pt-3 flex gap-2 border-b border-te-grey-300">
        {([['playlists', 'Playlists', ListMusic], ['search', 'Search songs', Search]] as const).map(([id, label, Icon]) => (
          <button
            key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`px-3 py-2 text-xs font-te-mono uppercase tracking-wider border-b-2 -mb-px flex items-center gap-1
              ${tab === id ? 'border-te-orange text-te-grey-800' : 'border-transparent text-te-grey-500 hover:text-te-grey-700'}`}
          >
            <Icon size={12} /> {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {listError && <p className="px-4 pt-3 text-xs font-te-mono text-te-red-500">{listError}</p>}

        {tab === 'playlists' && (
          playlists === null ? (
            !listError && <p className="te-label text-center mt-10 normal-case">Reading the playlists…</p>
          ) : playlists.length === 0 ? (
            <p className="te-label text-center mt-10 normal-case">This server has no playlists for {connection.username}.</p>
          ) : (
            <div>
              {playlists.map((p) => (
                <label key={p.id} className="flex items-center gap-3 px-4 py-2 border-b border-te-grey-200 text-xs cursor-pointer hover:bg-te-grey-100">
                  <input type="checkbox" disabled={running} checked={pickedPlaylists.has(p.id)} onChange={() => togglePlaylist(p.id)} aria-label={p.name} />
                  <ListMusic size={14} className="text-te-orange flex-shrink-0" />
                  <span className="te-value flex-1 truncate">{p.name}</span>
                  <span className="te-label normal-case">{plural(p.songCount, 'song')}</span>
                  <span className="te-label w-16 text-right">{formatDuration(p.duration)}</span>
                </label>
              ))}
            </div>
          )
        )}

        {tab === 'search' && (
          <div>
            <form onSubmit={search} className="px-4 py-3 flex gap-2 border-b border-te-grey-300">
              <input
                value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Artist, title or album…"
                className="input text-xs py-1 flex-1" aria-label="Search songs"
              />
              <button type="submit" disabled={searching || !query.trim()} className="btn-secondary text-xs disabled:opacity-40">
                {searching ? 'Searching…' : 'Search'}
              </button>
            </form>
            {results === null ? null : results.length === 0 ? (
              <p className="te-label text-center mt-10 normal-case">Nothing on the server matches “{query}”.</p>
            ) : (
              <div className="px-1">{results.map(songRow)}</div>
            )}
          </div>
        )}
      </div>

      <div className="flex-shrink-0 border-t-2 border-te-grey-300 bg-te-cream px-4 py-3 space-y-2">
        <div className="flex items-center gap-2">
          <label htmlFor="navidrome-destination" className="te-label text-xs whitespace-nowrap">Download to</label>
          <input
            id="navidrome-destination" value={destination || defaultDestination} onChange={(e) => setDestination(e.target.value)}
            className="input text-xs py-1 flex-1 font-te-mono" disabled={running}
          />
          <button onClick={pickFolder} aria-label="Browse" className="btn-ghost text-xs" disabled={running}><FolderOpen size={12} /></button>
        </div>

        {running && progress && (
          <div className="space-y-1">
            <p className="text-xs font-te-mono text-te-grey-600">
              {PHASE_TEXT[progress.phase]}{progress.phase === 'downloading' ? ` ${progress.current} of ${progress.total}` : ''}
              {progress.currentFile ? ` — ${progress.currentFile}` : ''}
            </p>
            {progress.phase === 'downloading' && progress.total > 0 && (
              <div className="w-full bg-te-grey-200 rounded-full h-1.5">
                <div className="bg-te-orange h-1.5 rounded-full transition-all" style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }} />
              </div>
            )}
          </div>
        )}

        {error && <p className="text-xs font-te-mono text-te-red-500">{error}</p>}

        {summary && !running && (
          <div className="text-xs font-te-mono text-te-grey-700 space-y-1">
            <p className="flex items-center gap-1">
              {summary.cancelled ? <X size={12} className="text-te-amber-600" /> : <CheckCircle size={12} className="text-te-green-600" />}
              {summary.cancelled
                ? `Cancelled — nothing was added to rekordbox. ${plural(summary.downloaded, 'file')} downloaded stay in the folder and are used next time.`
                : `${plural(summary.tracksAdded, 'track')} added${summary.tracksAlreadyThere ? `, ${summary.tracksAlreadyThere} already in the collection` : ''}`
                  + `${summary.playlists.length ? `; playlists: ${summary.playlists.map((p) => `${p.name} (${p.tracks})`).join(', ')}` : ''}.`}
            </p>
            {!summary.cancelled && <p className="text-te-grey-500">{plural(summary.downloaded, 'file')} downloaded, {summary.reused} already there. rekordbox analyses the new tracks the first time it opens them.</p>}
            {summary.playlistFileProblem && <p className="text-te-amber-600">The playlists were written, but rekordbox&apos;s playlist file could not be updated ({summary.playlistFileProblem}) — rekordbox may not show them.</p>}
            {summary.skipped.length > 0 && <details><summary className="cursor-pointer">{plural(summary.skipped.length, 'song')} left out</summary><ul>{summary.skipped.map((s, i) => <li key={i}>{s.title} — {s.reason}</li>)}</ul></details>}
            {summary.failed.length > 0 && <details open><summary className="cursor-pointer text-te-red-500">{plural(summary.failed.length, 'download')} failed</summary><ul>{summary.failed.map((f, i) => <li key={i}>{f.title} — {f.error}</li>)}</ul></details>}
            {summary.backupPath && <p className="text-te-grey-400">A backup was saved first — undo from the Backups tab.</p>}
            {!summary.cancelled && summary.tracksAdded > 0 && (
              <button onClick={() => onLoadLibrary?.(libraryPath)} className="btn-secondary text-xs">Load the updated library</button>
            )}
          </div>
        )}

        <div className="flex items-center gap-3">
          <p className="te-label normal-case text-xs flex-1">
            {nothingPicked ? 'Pick playlists or songs to import.' : `${plural(pickedPlaylists.size, 'playlist')} and ${plural(pickedSongs.size, 'song')} picked — about ${plural(pickedSongCount, 'track')}.`}
            {blocked && !nothingPicked && <span className="block text-te-amber-600">{blocked}</span>}
          </p>
          {running ? (
            <button onClick={cancel} className="btn-secondary text-xs flex items-center gap-1"><X size={12} /> Cancel</button>
          ) : (
            <button onClick={runImport} disabled={nothingPicked || Boolean(blocked)} className="btn-primary text-xs flex items-center gap-1 disabled:opacity-40">
              <Download size={12} /> Import into rekordbox
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
