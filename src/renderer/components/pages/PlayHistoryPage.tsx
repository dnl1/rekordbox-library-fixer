import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ListMusic, RefreshCw } from 'lucide-react';
import { useAppContext } from '../../AppWithRouter';
import { useSettingsStore } from '../../stores/settingsStore';
import { PageHeader } from '../ui';
import type { PlayHistorySession, PlayHistoryTrack } from '../../../main/ipcContract';

const formatDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: '2-digit' });

const formatClock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Sat, Sep 27, 2026 • 21 tracks • 18:17–19:52" */
const describe = (session: PlayHistorySession) => {
  const played = session.tracks.map((t) => t.playedAt).filter((t): t is string => Boolean(t));
  return [
    session.createdAt ? formatDay(session.createdAt) : null,
    plural(session.tracks.length, 'track'),
    played.length > 0 ? `${formatClock(played[0])}–${formatClock(played[played.length - 1])}` : null,
  ].filter(Boolean).join(' • ');
};

const matches = (track: PlayHistoryTrack, needle: string) =>
  `${track.artist} ${track.title}`.toLowerCase().includes(needle);

/**
 * rekordbox's own History: every session, and what was played in it, in order.
 * Nothing here writes to the database, so rekordbox may stay open.
 */
export const PlayHistoryPage: React.FC = () => {
  const { libraryPath } = useAppContext();
  const isDatabase = libraryPath.toLowerCase().endsWith('.db');
  const [sessions, setSessions] = useState<PlayHistorySession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await window.electronAPI.readPlayHistory({
      libraryPath,
      dbKey: useSettingsStore.getState().rekordboxDbKey,
    });
    setLoading(false);
    if (!res.success || !res.data) {
      setError(res.error ?? 'Could not read the play history.');
      return;
    }
    const read = res.data;
    setSessions(read);
    // The set just played is what this page is usually opened for.
    const latest = read.find((s) => s.tracks.length > 0);
    setExpanded((prev) => (prev.size > 0 || !latest ? prev : new Set([latest.id])));
  }, [libraryPath]);

  useEffect(() => { if (isDatabase) { void load(); } }, [isDatabase, load]);

  const needle = search.trim().toLowerCase();
  const visible = useMemo(() => {
    const all = sessions ?? [];
    if (!needle) { return all.map((session) => ({ session, tracks: session.tracks })); }
    return all
      .map((session) => ({ session, tracks: session.tracks.filter((t) => matches(t, needle)) }))
      .filter((v) => v.tracks.length > 0);
  }, [sessions, needle]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  };

  const trackCount = (sessions ?? []).reduce((n, s) => n + s.tracks.length, 0);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        icon={ListMusic}
        title="Play History"
        stats={sessions ? `${plural(sessions.length, 'session')} · ${plural(trackCount, 'track')} played` : undefined}
        actions={isDatabase && (
          <button onClick={() => void load()} disabled={loading} className="btn-ghost text-xs disabled:opacity-40">
            <RefreshCw size={12} className={`inline mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        )}
      />

      {isDatabase && (
        <div className="px-4 py-3 flex flex-wrap items-center gap-2 border-b border-te-grey-300">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search artist or track..."
            className="input text-xs py-1 flex-1 min-w-[200px]"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {error && <p className="text-xs font-te-mono text-te-red-500 normal-case">{error}</p>}

        {!isDatabase ? (
          <p className="te-label text-center mt-10 normal-case">
            The play history is read from rekordbox&apos;s own database. Open master.db from the
            Library tab to see it.
          </p>
        ) : !sessions ? (
          loading && <p className="te-label text-center mt-10 normal-case">Reading rekordbox&apos;s history…</p>
        ) : visible.length === 0 ? (
          <p className="te-label text-center mt-10 normal-case">
            {sessions.length === 0
              ? 'rekordbox has no play history yet. Sets appear here once rekordbox has recorded them.'
              : 'No track in the history matches this search.'}
          </p>
        ) : (
          visible.map(({ session, tracks }) => {
            // A search shows every session it found, open, so the answer is not one click away.
            const isOpen = Boolean(needle) || expanded.has(session.id);
            return (
              <div key={session.id} className="card p-3">
                <button
                  onClick={() => toggle(session.id)}
                  aria-expanded={isOpen}
                  className="w-full flex items-start gap-2 text-left"
                >
                  {isOpen ? <ChevronDown size={14} className="mt-1 flex-shrink-0" />
                    : <ChevronRight size={14} className="mt-1 flex-shrink-0" />}
                  <ListMusic size={14} className="mt-1 flex-shrink-0 text-te-orange" />
                  <span className="flex-1 min-w-0">
                    <span className="te-value text-sm block">{session.name}</span>
                    <span className="te-label text-xs normal-case">{describe(session)}</span>
                  </span>
                </button>

                {isOpen && (
                  <ol className="mt-2 ml-6 space-y-1">
                    {tracks.map((track, i) => (
                      <li key={`${track.trackNo}-${i}`} className="flex items-baseline gap-3 text-xs">
                        <span className="te-label w-6 text-right flex-shrink-0">{track.trackNo}</span>
                        <span className="te-label w-12 flex-shrink-0">
                          {track.playedAt ? formatClock(track.playedAt) : '—'}
                        </span>
                        {track.inCollection ? (
                          <span className="te-value min-w-0 truncate" title={track.location}>
                            {track.artist ? `${track.artist} — ` : ''}{track.title || 'Untitled'}
                          </span>
                        ) : (
                          <span className="text-te-grey-400 italic font-te-mono">No longer in the collection</span>
                        )}
                      </li>
                    ))}
                    {tracks.length === 0 && (
                      <li className="te-label text-xs normal-case">Nothing was played in this session.</li>
                    )}
                  </ol>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
