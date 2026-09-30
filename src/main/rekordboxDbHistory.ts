import Database from 'better-sqlite3-multiple-ciphers';
import type { PlayHistorySession, PlayHistoryTrack } from './ipcContract';

type Db = InstanceType<typeof Database>;

/**
 * rekordbox's own History: every session, and what was played in it.
 *
 * Facts verified against a real rekordbox 7.2 library:
 * - `djmdHistory` holds the sessions (Attribute 0, named "HISTORY 2026-09-27",
 *   then "HISTORY 2026-09-27 (1)" for a second one that day) and also the year
 *   and month folders they sit in (Attribute 1, named "2026" and "9"). Only
 *   sessions carry tracks, so only sessions are returned.
 * - `djmdSongHistory` links a session to each track it played, numbered by
 *   TrackNo from 1. Its `created_at` is when the track entered the history.
 * - `created_at` is UTC, written "2026-09-27 21:04:20.692 +00:00".
 *   `djmdHistory.DateCreated` is local time with no zone at all, so it is not
 *   used: nothing in the row says which zone it was written in.
 * - An entry can point at a track the collection no longer has. It is kept and
 *   marked rather than dropped, or a set would read shorter than it was played.
 */

interface SessionRow {
  ID: string | number;
  Name: string | null;
  created_at: string | null;
}

interface EntryRow {
  HistoryID: string | number;
  ContentID: string | number | null;
  TrackNo: number | null;
  created_at: string | null;
  FoundID: string | number | null;
  Title: string | null;
  FolderPath: string | null;
  ArtistName: string | null;
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})$/;

/**
 * An ISO instant from rekordbox's "2026-09-27 21:04:20.692 +00:00", which is
 * not a format `Date` is required to parse. A value without a zone gives
 * undefined: guessing one would move every track by the viewer's offset.
 */
export function rekordboxTimestampToIso(value: string | null | undefined): string | undefined {
  const match = TIMESTAMP.exec((value ?? '').trim());
  if (!match) { return undefined; }
  const [, day, time, fraction, zone] = match;
  const millis = (fraction ?? '').padEnd(3, '0').slice(0, 3);
  const offset = zone === 'Z' || zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const date = new Date(`${day}T${time}.${millis}${offset}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Every History session, newest first, each with its tracks in the order they were played. */
export function readPlayHistory(db: Db): PlayHistorySession[] {
  const sessions = db.prepare(`
    SELECT ID, Name, created_at FROM djmdHistory
    WHERE Attribute = 0 AND rb_local_deleted = 0
  `).all() as SessionRow[];

  const tracksBySession = new Map<string, PlayHistoryTrack[]>();
  for (const row of db.prepare(`
    SELECT sh.HistoryID, sh.ContentID, sh.TrackNo, sh.created_at,
           c.ID AS FoundID, c.Title, c.FolderPath, ar.Name AS ArtistName
    FROM djmdSongHistory sh
    LEFT JOIN djmdContent c ON c.ID = sh.ContentID AND c.rb_local_deleted = 0
    LEFT JOIN djmdArtist ar ON ar.ID = c.ArtistID AND ar.rb_local_deleted = 0
    WHERE sh.rb_local_deleted = 0
    ORDER BY sh.TrackNo, sh.created_at
  `).all() as EntryRow[]) {
    const sessionId = String(row.HistoryID);
    let tracks = tracksBySession.get(sessionId);
    if (!tracks) { tracks = []; tracksBySession.set(sessionId, tracks); }
    tracks.push({
      trackNo: row.TrackNo ?? 0,
      contentId: row.ContentID === null ? '' : String(row.ContentID),
      playedAt: rekordboxTimestampToIso(row.created_at),
      title: row.Title ?? '',
      artist: row.ArtistName ?? '',
      location: row.FolderPath ?? '',
      inCollection: row.FoundID !== null,
    });
  }

  return sessions
    .map((row) => {
      const tracks = tracksBySession.get(String(row.ID)) ?? [];
      return {
        id: String(row.ID),
        name: row.Name ?? '',
        // A session row without a usable stamp still has its first track's.
        createdAt: rekordboxTimestampToIso(row.created_at) ?? tracks.find((t) => t.playedAt)?.playedAt,
        tracks,
      };
    })
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.name.localeCompare(a.name));
}
