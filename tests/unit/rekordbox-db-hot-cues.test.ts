import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.unmock('fs');
vi.unmock('crypto');

import Database from 'better-sqlite3-multiple-ciphers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyHotCues, readHotCueCandidates, writeHotCuesToDb } from '../../src/main/rekordboxDbHotCues';

let file: string;
let db: InstanceType<typeof Database>;

beforeEach(() => {
  file = path.join(os.tmpdir(), `hc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new Database(file);
  // The djmdCue columns are rekordbox 7's, as a real library has them.
  db.exec(`
    CREATE TABLE djmdContent (ID TEXT PRIMARY KEY, UUID TEXT, Title TEXT, ArtistID TEXT, FolderPath TEXT,
      AnalysisDataPath TEXT, rb_local_deleted INTEGER DEFAULT 0);
    CREATE TABLE djmdArtist (ID TEXT PRIMARY KEY, Name TEXT, rb_local_deleted INTEGER DEFAULT 0);
    CREATE TABLE djmdCue (ID TEXT PRIMARY KEY, ContentID TEXT, InMsec INTEGER, InFrame INTEGER, InMpegFrame INTEGER,
      InMpegAbs INTEGER, OutMsec INTEGER, OutFrame INTEGER, OutMpegFrame INTEGER, OutMpegAbs INTEGER, Kind INTEGER,
      Color INTEGER, ColorTableIndex INTEGER, ActiveLoop INTEGER, Comment TEXT, BeatLoopSize INTEGER, CueMicrosec INTEGER,
      InPointSeekInfo TEXT, OutPointSeekInfo TEXT, ContentUUID TEXT, UUID TEXT, rb_data_status INTEGER,
      rb_local_data_status INTEGER, rb_local_deleted INTEGER, rb_local_synced INTEGER, usn INTEGER, rb_local_usn INTEGER,
      created_at TEXT, updated_at TEXT);
    INSERT INTO djmdArtist VALUES ('a1', 'Someone', 0);
    INSERT INTO djmdContent VALUES
      ('t1', 'uuid-1', 'Bare', 'a1', '/m/bare.mp3', '/PIONEER/USBANLZ/1/ANLZ0000.DAT', 0),
      ('t2', 'uuid-2', 'Memory only', 'a1', '/m/mem.mp3', NULL, 0),
      ('t3', 'uuid-3', 'Hand cued', 'a1', '/m/hand.mp3', NULL, 0),
      ('t4', 'uuid-4', 'Deleted cue', 'a1', '/m/del.mp3', NULL, 0),
      ('t5', 'uuid-5', 'Gone', 'a1', '/m/gone.mp3', NULL, 1);
    INSERT INTO djmdCue (ID, ContentID, Kind, InMsec, rb_local_deleted) VALUES
      ('m1', 't2', 0, 1000, 0),
      ('h1', 't3', 5, 2000, 0),
      ('d1', 't4', 1, 3000, 1);
  `);
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const f of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(path.basename(file)))) {
    fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  }
});

const cuesOf = (id: string) => db.prepare('SELECT * FROM djmdCue WHERE ContentID = ? AND rb_local_deleted = 0 ORDER BY Kind').all(id) as any[];

describe('readHotCueCandidates', () => {
  it('offers tracks with no hot cue — a memory cue or a deleted one does not count', () => {
    const c = readHotCueCandidates(db);
    expect(c.tracks.map((t) => t.id).sort()).toEqual(['t1', 't2', 't4']);
    expect(c.alreadyCued).toBe(1);
    expect(c.tracks.find((t) => t.id === 't1')).toEqual({
      id: 't1', title: 'Bare', artist: 'Someone', location: '/m/bare.mp3', analysisDataPath: '/PIONEER/USBANLZ/1/ANLZ0000.DAT',
    });
  });

  it('keeps to a playlist when given one', () => {
    const c = readHotCueCandidates(db, ['t1', 't3']);
    expect(c.tracks.map((t) => t.id)).toEqual(['t1']);
    expect(c.alreadyCued).toBe(1);
  });
});

describe('applyHotCues', () => {
  const now = new Date('2026-09-28T18:44:53.627Z');

  it('writes each cue as rekordbox writes one', () => {
    const out = applyHotCues(db, [{ trackId: 't1', cues: [{ kind: 1, name: 'Intro', ms: 200 }, { kind: 2, name: 'Chorus', ms: 26881 }] }], now);
    expect(out).toEqual({ tracksWritten: 1, cuesWritten: 2, skipped: [] });
    const [a, b] = cuesOf('t1');
    expect(b).toMatchObject({
      Kind: 2, InMsec: 26881, InFrame: 4032, OutMsec: -1, Comment: 'Chorus', Color: -1, ColorTableIndex: null,
      ContentUUID: 'uuid-1', rb_local_deleted: 0, created_at: '2026-09-28 18:44:53.627 +00:00',
    });
    expect(a.UUID).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.ID).not.toBe(b.ID);
  });

  it('adds hot cues beside a memory cue, leaving it alone', () => {
    applyHotCues(db, [{ trackId: 't2', cues: [{ kind: 1, name: 'Intro', ms: 0 }] }], now);
    expect(cuesOf('t2').map((c) => [c.ID, c.Kind])).toEqual([['m1', 0], [expect.any(String), 1]]);
  });

  it('leaves alone a track that has a hot cue by the time of the write', () => {
    const out = applyHotCues(db, [{ trackId: 't3', cues: [{ kind: 1, name: 'Intro', ms: 0 }] }], now);
    expect(out.skipped).toEqual([{ trackId: 't3', reason: 'it has a hot cue now' }]);
    expect(cuesOf('t3')).toHaveLength(1);
  });

  it('refuses a slot rekordbox never uses, a slot twice, or a track no longer there', () => {
    const out = applyHotCues(db, [
      { trackId: 't1', cues: [{ kind: 4, name: 'X', ms: 0 }] },
      { trackId: 't4', cues: [{ kind: 1, name: 'X', ms: 0 }, { kind: 1, name: 'Y', ms: 10 }] },
      { trackId: 't5', cues: [{ kind: 1, name: 'X', ms: 0 }] },
    ], now);
    expect(out.cuesWritten).toBe(0);
    expect(out.skipped.map((s) => s.trackId)).toEqual(['t1', 't4', 't5']);
    expect(out.skipped[2].reason).toBe('not in the collection');
  });
});

describe('writeHotCuesToDb', () => {
  it('refuses while rekordbox runs, and never writes without a backup', () => {
    db.close();
    const writes = [{ trackId: 't1', cues: [{ kind: 1, name: 'Intro', ms: 0 }] }];
    expect(() => writeHotCuesToDb(file, 'k', writes, { backupPath: `${file}.bak`, checkRunning: () => true })).toThrow(/Close rekordbox/);
    expect(() => writeHotCuesToDb(file, 'k', writes, { backupPath: '', checkRunning: () => false })).toThrow(/backup path is required/);
  });
});
