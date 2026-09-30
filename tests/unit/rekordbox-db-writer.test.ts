import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.unmock('fs');

import Database from 'better-sqlite3-multiple-ciphers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyMerges, mergeDuplicateEntries } from '../../src/main/rekordboxDbWriter';

let file: string;
let db: InstanceType<typeof Database>;

beforeEach(() => {
  file = path.join(os.tmpdir(), `wr-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new Database(file);
  db.exec(`
    CREATE TABLE djmdContent (ID TEXT PRIMARY KEY, Title TEXT, rb_local_deleted INTEGER DEFAULT 0, FolderPath TEXT);
    CREATE TABLE djmdSongPlaylist (
      ID TEXT PRIMARY KEY, PlaylistID TEXT, ContentID TEXT, rb_local_deleted INTEGER DEFAULT 0);
    -- dup2 shares the kept entry's file; dup1 is a genuine second copy
    INSERT INTO djmdContent VALUES ('keep','Song',0,'/Music/song.mp3'), ('dup1','Song',0,'/Music/copy/song.mp3'), ('dup2','Song',0,'/Music/song.mp3');
    -- playlist A holds only the duplicate; playlist B holds both
    INSERT INTO djmdSongPlaylist VALUES ('l1','A','dup1',0);
    INSERT INTO djmdSongPlaylist VALUES ('l2','B','keep',0);
    INSERT INTO djmdSongPlaylist VALUES ('l3','B','dup1',0);
    INSERT INTO djmdSongPlaylist VALUES ('l4','A','dup2',0);
    CREATE TABLE djmdCue (ID TEXT PRIMARY KEY, ContentID TEXT);
    INSERT INTO djmdCue VALUES ('c1','dup1'), ('c2','keep');
    CREATE TABLE agentRegistry (registry_id TEXT PRIMARY KEY, int_1 INTEGER);
    INSERT INTO agentRegistry VALUES ('localUpdateCount', 100);
    -- set s1 played dup1 twice and keep once; set s2 played dup2
    CREATE TABLE djmdSongHistory (ID TEXT PRIMARY KEY, HistoryID TEXT, ContentID TEXT, TrackNo INTEGER, rb_local_deleted INTEGER DEFAULT 0);
    INSERT INTO djmdSongHistory VALUES ('h1','s1','dup1',1,0), ('h2','s1','keep',2,0), ('h3','s1','dup1',3,0), ('h4','s2','dup2',1,0);
  `);
});

const history = () =>
  db.prepare('SELECT HistoryID, TrackNo, ContentID FROM djmdSongHistory ORDER BY HistoryID, TrackNo').all();

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(file, { force: true });
});

const links = () =>
  db.prepare('SELECT PlaylistID, ContentID FROM djmdSongPlaylist WHERE rb_local_deleted = 0 ORDER BY PlaylistID, ContentID').all();
const alive = () =>
  db.prepare('SELECT ID FROM djmdContent WHERE rb_local_deleted = 0').all().map((r: any) => r.ID);

describe('applyMerges', () => {
  it('really removes the duplicate rows rather than flagging them', () => {
    applyMerges(db, [{ keepId: 'keep', removeIds: ['dup1'] }]);
    // Flagging left the tracks visible in rekordbox, so the row must be gone.
    const row = db.prepare('SELECT ID FROM djmdContent WHERE ID = ?').get('dup1');
    expect(row).toBeUndefined();
  });

  it('clears rows in tables that referenced the removed track', () => {
    applyMerges(db, [{ keepId: 'keep', removeIds: ['dup1'] }]);
    expect(db.prepare('SELECT ID FROM djmdCue WHERE ContentID = ?').get('dup1')).toBeUndefined();
    // The kept track's own cues stay.
    expect(db.prepare('SELECT ID FROM djmdCue WHERE ContentID = ?').get('keep')).toBeTruthy();
  });

  it('advances rekordbox\'s local update counter', () => {
    const before = (db.prepare("SELECT int_1 AS n FROM agentRegistry WHERE registry_id='localUpdateCount'").get() as any).n;
    applyMerges(db, [{ keepId: 'keep', removeIds: ['dup1', 'dup2'] }]);
    const after = (db.prepare("SELECT int_1 AS n FROM agentRegistry WHERE registry_id='localUpdateCount'").get() as any).n;
    expect(after).toBeGreaterThan(before);
  });

  it('retires the duplicate entries and keeps the chosen one', () => {
    const result = applyMerges(db, [{ keepId: 'keep', removeIds: ['dup1', 'dup2'] }]);
    expect(alive()).toEqual(['keep']);
    expect(result.entriesRemoved).toBe(2);
  });

  it('moves a playlist that held only the duplicate onto the kept entry', () => {
    applyMerges(db, [{ keepId: 'keep', removeIds: ['dup1', 'dup2'] }]);
    // Playlist A had no link to keep, so it must now point at keep — once.
    expect(links().filter((l: any) => l.PlaylistID === 'A')).toEqual([{ PlaylistID: 'A', ContentID: 'keep' }]);
  });

  it('does not add a second link where the playlist already had the kept entry', () => {
    applyMerges(db, [{ keepId: 'keep', removeIds: ['dup1'] }]);
    expect(links().filter((l: any) => l.PlaylistID === 'B')).toEqual([{ PlaylistID: 'B', ContentID: 'keep' }]);
  });

  it('leaves the kept entry alone when it is listed among the removals', () => {
    applyMerges(db, [{ keepId: 'keep', removeIds: ['keep'] }]);
    expect(alive()).toContain('keep');
  });

  it('touches nothing when the plan is empty', () => {
    const before = links();
    applyMerges(db, []);
    expect(links()).toEqual(before);
    expect(alive()).toHaveLength(3);
  });

  it('reports where the removed entries pointed and what the collection still uses', () => {
    const result = applyMerges(db, [{ keepId: 'keep', removeIds: ['dup1', 'dup2'] }]);
    expect(result.removedLocations).toEqual(['/Music/copy/song.mp3', '/Music/song.mp3']);
    // The kept entry's file is still in use, so nothing may trash it.
    expect(result.remainingLocations).toEqual(['/Music/song.mp3']);
  });

  it('leaves a set alone when the kept file is gone but a copy being retired is there', () => {
    const onlyCopy = (p: string) => p === '/Music/copy/song.mp3';
    const result = applyMerges(db, [{ keepId: 'keep', removeIds: ['dup1', 'dup2'] }], onlyCopy);
    expect(result.entriesRemoved).toBe(0);
    expect(result.removedLocations).toEqual([]);
    expect(result.skipped).toEqual([{ keepId: 'keep', reason: expect.stringContaining('/Music/copy/song.mp3') }]);
    expect(alive()).toHaveLength(3);
    expect(result.historyEntriesMoved).toBe(0);
  });

  it('keeps every play of a retired copy in the history, on the kept entry and in its place', () => {
    const result = applyMerges(db, [{ keepId: 'keep', removeIds: ['dup1', 'dup2'] }]);
    // A set that played the song twice still did: history is not deduplicated like a playlist.
    expect(history()).toEqual([
      { HistoryID: 's1', TrackNo: 1, ContentID: 'keep' },
      { HistoryID: 's1', TrackNo: 2, ContentID: 'keep' },
      { HistoryID: 's1', TrackNo: 3, ContentID: 'keep' },
      { HistoryID: 's2', TrackNo: 1, ContentID: 'keep' },
    ]);
    expect(result.historyEntriesMoved).toBe(3);
  });

  it('counts the moved plays as changes for rekordbox', () => {
    applyMerges(db, [{ keepId: 'keep', removeIds: ['dup1', 'dup2'] }]);
    // 2 entries removed + 1 playlist link moved (A) + 3 plays moved.
    expect((db.prepare("SELECT int_1 AS n FROM agentRegistry WHERE registry_id='localUpdateCount'").get() as any).n).toBe(106);
  });

  it('works on a database without a history table', () => {
    db.exec('DROP TABLE djmdSongHistory');
    const result = applyMerges(db, [{ keepId: 'keep', removeIds: ['dup1'] }]);
    expect(result.entriesRemoved).toBe(1);
    expect(result.historyEntriesMoved).toBe(0);
  });
});

describe('mergeDuplicateEntries safety', () => {
  it('refuses to write while rekordbox is running', () => {
    expect(() => mergeDuplicateEntries(file, 'k', [], {
      backupPath: `${file}.bak`,
      checkRunning: () => true,
    })).toThrow(/close rekordbox/i);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it('refuses to write without a backup path', () => {
    expect(() => mergeDuplicateEntries(file, 'k', [], {
      backupPath: '',
      checkRunning: () => false,
    })).toThrow(/backup/i);
  });
});
