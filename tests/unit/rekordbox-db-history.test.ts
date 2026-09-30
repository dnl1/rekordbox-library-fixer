import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.unmock('fs');

import Database from 'better-sqlite3-multiple-ciphers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readPlayHistory, rekordboxTimestampToIso } from '../../src/main/rekordboxDbHistory';

let file: string;
let db: InstanceType<typeof Database>;

beforeEach(() => {
  file = path.join(os.tmpdir(), `ph-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new Database(file);
  // Laid out as a real rekordbox 7 library lays out its History: a year
  // folder, a month folder in it, and the sessions in that.
  db.exec(`
    CREATE TABLE djmdHistory (ID TEXT PRIMARY KEY, Seq INTEGER, Name TEXT, Attribute INTEGER, ParentID TEXT,
      DateCreated TEXT, UUID TEXT, rb_local_deleted INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
    CREATE TABLE djmdSongHistory (ID TEXT PRIMARY KEY, HistoryID TEXT, ContentID TEXT, TrackNo INTEGER,
      UUID TEXT, rb_local_deleted INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
    CREATE TABLE djmdContent (ID TEXT PRIMARY KEY, Title TEXT, ArtistID TEXT, FolderPath TEXT, rb_local_deleted INTEGER DEFAULT 0);
    CREATE TABLE djmdArtist (ID TEXT PRIMARY KEY, Name TEXT, rb_local_deleted INTEGER DEFAULT 0);

    INSERT INTO djmdArtist VALUES ('a1', 'Avalon', 0), ('a2', 'Tiësto', 0);
    INSERT INTO djmdContent VALUES
      ('c1', 'Dusk Till Dawn', 'a1', '/m/dusk.mp3', 0),
      ('c2', 'Adagio for Strings', 'a2', '/m/adagio.mp3', 0),
      ('c3', 'Explorers', 'a1', '/m/explorers.mp3', 0),
      ('c4', 'Removed since', 'a1', '/m/removed.mp3', 1);

    INSERT INTO djmdHistory (ID, Seq, Name, Attribute, ParentID, DateCreated, created_at, rb_local_deleted) VALUES
      ('2026', 1, '2026', 1, 'root', '2026-09-01 10:00:00', '2026-09-01 13:00:00.000 +00:00', 0),
      ('202609', 1, '9', 1, '2026', '2026-09-01 10:00:00', '2026-09-01 13:00:00.000 +00:00', 0),
      ('s1', 1, 'HISTORY 2026-09-27', 0, '202609', '2026-09-27 18:04:00', '2026-09-27 21:04:00.100 +00:00', 0),
      ('s2', 2, 'HISTORY 2026-09-27 (1)', 0, '202609', '2026-09-27 18:17:00', '2026-09-27 21:17:00.000 +00:00', 0),
      ('s3', 3, 'HISTORY 2026-09-20', 0, '202609', '2026-09-20 20:00:00', '2026-09-20 23:00:00.000 +00:00', 0),
      ('s4', 4, 'HISTORY 2026-09-26', 0, '202609', '2026-09-26 20:00:00', '2026-09-26 23:00:00.000 +00:00', 1);

    INSERT INTO djmdSongHistory (ID, HistoryID, ContentID, TrackNo, created_at, rb_local_deleted) VALUES
      ('e3', 's1', 'c2', 3, '2026-09-27 21:14:12.341 +00:00', 0),
      ('e1', 's1', 'c1', 1, '2026-09-27 21:04:20.692 +00:00', 0),
      ('e2', 's1', 'c9', 2, '2026-09-27 21:11:12.952 +00:00', 0),
      ('e4', 's2', 'c4', 1, '2026-09-27 21:17:01.341 +00:00', 0),
      ('e5', 's2', 'c3', 2, '2026-09-27 21:18:40.335 +00:00', 0),
      ('e6', 's2', 'c2', 3, '2026-09-27 21:22:50.993 +00:00', 1),
      ('e7', 's4', 'c1', 1, '2026-09-26 23:01:00.000 +00:00', 0);
  `);
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const f of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(path.basename(file)))) {
    fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  }
});

describe('readPlayHistory', () => {
  it('returns the sessions, newest first — not the year and month folders they sit in', () => {
    expect(readPlayHistory(db).map((s) => s.name)).toEqual([
      'HISTORY 2026-09-27 (1)', 'HISTORY 2026-09-27', 'HISTORY 2026-09-20',
    ]);
  });

  it('lists each session in the order it was played, whatever order the rows are stored in', () => {
    const [, first] = readPlayHistory(db);
    expect(first.id).toBe('s1');
    expect(first.createdAt).toBe('2026-09-27T21:04:00.100Z');
    expect(first.tracks.map((t) => t.trackNo)).toEqual([1, 2, 3]);
    expect(first.tracks[0]).toEqual({
      trackNo: 1, contentId: 'c1', playedAt: '2026-09-27T21:04:20.692Z',
      title: 'Dusk Till Dawn', artist: 'Avalon', location: '/m/dusk.mp3', inCollection: true,
    });
  });

  it('keeps an entry whose track the collection no longer has, and says so', () => {
    const [second, first] = readPlayHistory(db);
    // c9 never existed; c4 is deleted. Both sets keep their length.
    expect(first.tracks[1]).toMatchObject({ trackNo: 2, contentId: 'c9', title: '', inCollection: false });
    expect(second.tracks[0]).toMatchObject({ trackNo: 1, contentId: 'c4', title: '', inCollection: false });
  });

  it('leaves out deleted sessions and deleted entries', () => {
    const history = readPlayHistory(db);
    expect(history.map((s) => s.id)).not.toContain('s4');
    expect(history[0].tracks.map((t) => t.contentId)).toEqual(['c4', 'c3']);
  });

  it('returns a session nothing was played in, as rekordbox shows it', () => {
    expect(readPlayHistory(db)[2]).toMatchObject({ id: 's3', tracks: [] });
  });

  it('dates a session with no stamp of its own by its first track', () => {
    db.exec(`UPDATE djmdHistory SET created_at = NULL WHERE ID = 's1'`);
    const s1 = readPlayHistory(db).find((s) => s.id === 's1')!;
    expect(s1.createdAt).toBe('2026-09-27T21:04:20.692Z');
  });
});

describe('rekordboxTimestampToIso', () => {
  it('reads the UTC stamp rekordbox writes', () => {
    expect(rekordboxTimestampToIso('2026-09-27 21:04:20.692 +00:00')).toBe('2026-09-27T21:04:20.692Z');
  });

  it('honours another offset, with or without its colon', () => {
    expect(rekordboxTimestampToIso('2026-09-27 18:04:20.692 -03:00')).toBe('2026-09-27T21:04:20.692Z');
    expect(rekordboxTimestampToIso('2026-09-27 18:04:20 -0300')).toBe('2026-09-27T21:04:20.000Z');
  });

  it('keeps milliseconds from a longer fraction', () => {
    expect(rekordboxTimestampToIso('2026-09-27 21:04:20.692123 +00:00')).toBe('2026-09-27T21:04:20.692Z');
  });

  it('gives nothing for a stamp without a zone, rather than guessing one', () => {
    // djmdHistory.DateCreated looks like this, in local time.
    expect(rekordboxTimestampToIso('2026-09-27 18:04:20')).toBeUndefined();
    expect(rekordboxTimestampToIso('')).toBeUndefined();
    expect(rekordboxTimestampToIso(null)).toBeUndefined();
    expect(rekordboxTimestampToIso('yesterday')).toBeUndefined();
  });
});
