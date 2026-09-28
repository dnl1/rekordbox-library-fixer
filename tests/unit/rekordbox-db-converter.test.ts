import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.unmock('fs');

import Database from 'better-sqlite3-multiple-ciphers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyConversions, writeConversionsToDb, type ConversionWritePlan } from '../../src/main/rekordboxDbConverter';

let file: string;
let db: InstanceType<typeof Database>;
const anyFileExists = () => true;

beforeEach(() => {
  file = path.join(os.tmpdir(), `cv-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new Database(file);
  db.exec(`
    CREATE TABLE djmdContent (
      ID TEXT PRIMARY KEY, Title TEXT, FolderPath TEXT, FileNameL TEXT, FileType INTEGER,
      FileSize INTEGER, BitRate INTEGER, BitDepth INTEGER, SampleRate INTEGER,
      rb_file_id TEXT, rb_local_usn INTEGER, rb_local_deleted INTEGER DEFAULT 0);
    INSERT INTO djmdContent VALUES
      ('t1','Song','/m/Song.flac','Song.flac',5,30000000,1000,24,96000,'555',10,0),
      ('t2','Other','/m/Other.flac','Other.flac',5,20000000,900,16,44100,'556',10,0);
    CREATE TABLE djmdCue (ID TEXT PRIMARY KEY, ContentID TEXT);
    INSERT INTO djmdCue VALUES ('c1','t1');
    CREATE TABLE agentRegistry (registry_id TEXT PRIMARY KEY, int_1 INTEGER);
    INSERT INTO agentRegistry VALUES ('localUpdateCount', 100);
  `);
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const f of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(path.basename(file)))) {
    fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  }
});

const row = (id: string) => db.prepare('SELECT * FROM djmdContent WHERE ID = ?').get(id) as any;

const aiff: ConversionWritePlan = {
  trackId: 't1', oldLocation: '/m/Song.flac', newLocation: '/m/Song.aiff', format: 'aiff',
  size: 55000000, sampleRate: 96000, bitDepth: 24, bitRate: 4608,
};

describe('applyConversions', () => {
  it('points the track at the converted file and says what the file is', () => {
    const out = applyConversions(db, [aiff], anyFileExists);
    expect(out.tracksUpdated).toBe(1);
    expect(row('t1')).toMatchObject({
      FolderPath: '/m/Song.aiff', FileNameL: 'Song.aiff', FileType: 12,
      FileSize: 55000000, BitRate: 4608, BitDepth: 24, SampleRate: 96000,
    });
  });

  it('marks WAV and MP3 with their own file types', () => {
    applyConversions(db, [
      { ...aiff, newLocation: '/m/Song.wav', format: 'wav' },
      { ...aiff, trackId: 't2', oldLocation: '/m/Other.flac', newLocation: '/m/Other.mp3', format: 'mp3', bitRate: 320 },
    ], anyFileExists);
    expect(row('t1').FileType).toBe(11);
    expect(row('t2')).toMatchObject({ FileType: 1, BitRate: 320 });
  });

  it('keeps the cues, the analysis link and the id', () => {
    applyConversions(db, [aiff], anyFileExists);
    expect(row('t1').rb_file_id).toBe('555');
    expect(db.prepare('SELECT ID FROM djmdCue WHERE ContentID = ?').get('t1')).toBeTruthy();
  });

  it('numbers the change so rekordbox notices it', () => {
    applyConversions(db, [aiff], anyFileExists);
    expect(row('t1').rb_local_usn).toBe(101);
  });

  it('leaves an entry that points elsewhere since the library was loaded', () => {
    // Re-pointing it would swap one recording for another.
    db.prepare("UPDATE djmdContent SET FolderPath = '/elsewhere/Song.flac' WHERE ID = 't1'").run();
    const out = applyConversions(db, [aiff], anyFileExists);
    expect(out.tracksUpdated).toBe(0);
    expect(out.skipped[0].reason).toMatch(/different file/);
    expect(row('t1').FolderPath).toBe('/elsewhere/Song.flac');
  });

  it('compares the old path in NFC', () => {
    db.prepare("UPDATE djmdContent SET FolderPath = ? WHERE ID = 't1'").run('/m/Café.flac'.normalize('NFD'));
    const out = applyConversions(db, [{ ...aiff, oldLocation: '/m/Café.flac' }], anyFileExists);
    expect(out.tracksUpdated).toBe(1);
  });

  it('refuses a converted file that is not there', () => {
    const out = applyConversions(db, [aiff], () => false);
    expect(out.tracksUpdated).toBe(0);
    expect(row('t1').FolderPath).toBe('/m/Song.flac');
  });

  it('skips a track that is not in the collection', () => {
    const out = applyConversions(db, [{ ...aiff, trackId: 'ghost' }], anyFileExists);
    expect(out.skipped).toEqual([{ trackId: 'ghost', reason: 'not in the collection' }]);
  });
});

describe('writeConversionsToDb', () => {
  it('refuses to write while rekordbox is running', () => {
    expect(() => writeConversionsToDb(file, 'k', [aiff], { backupPath: `${file}.bak`, checkRunning: () => true }))
      .toThrow(/Close rekordbox/);
  });

  it('refuses to write without a backup', () => {
    expect(() => writeConversionsToDb(file, 'k', [aiff], { backupPath: '', checkRunning: () => false }))
      .toThrow(/backup/);
  });
});
