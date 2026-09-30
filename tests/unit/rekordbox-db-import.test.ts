import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.unmock('fs');
vi.unmock('crypto');

import Database from 'better-sqlite3-multiple-ciphers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { addMasterPlaylistNodes, applyImport, importIntoDb, type ImportTrack } from '../../src/main/rekordboxDbImport';
import { unlockDatabase } from '../../src/main/rekordboxDbParser';

type Db = InstanceType<typeof Database>;

// The real rekordbox 7.2 tables, so a column this writes that rekordbox does
// not have — or a type it would reject — fails here rather than in rekordbox.
const SCHEMA = fs.readFileSync(path.join(__dirname, '../fixtures/rekordbox7-import-schema.sql'), 'utf8');

const SEED = `
  INSERT INTO djmdDevice (ID, MasterDBID, Name, created_at, updated_at) VALUES ('dev-uuid', '331342631', 'DJ', 'x', 'x');
  INSERT INTO djmdMenuItems (ID, Class, Name, rb_local_usn, created_at, updated_at) VALUES ('4', -125, 'TRACK', 13, 'x', 'x');
  INSERT INTO agentRegistry (registry_id, int_1, created_at, updated_at) VALUES ('localUpdateCount', 1000, 'x', 'x');
  INSERT INTO djmdArtist (ID, Name, rb_local_deleted, created_at, updated_at) VALUES ('900', 'Avalon', 0, 'x', 'x');
  INSERT INTO djmdContent (ID, FolderPath, Title, rb_local_deleted, created_at, updated_at) VALUES ('800', '/music/existing.mp3', 'Old', 0, 'x', 'x');
  INSERT INTO djmdPlaylist (ID, Seq, Name, Attribute, ParentID, rb_local_deleted, created_at, updated_at) VALUES ('700', 5, 'Peak', 0, 'root', 0, 'x', 'x');
`;

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbi-'));
  db = new Database(path.join(dir, 'plain.db'));
  db.exec(SCHEMA);
  db.exec(SEED);
});
afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const now = new Date('2026-09-30T21:04:20.692Z');
/** IDs 1001, 1002, … so the rows can be named in the assertions. */
const counter = () => { let n = 1000; return () => ++n; };

const track = (location: string, over: Partial<ImportTrack> = {}): ImportTrack => ({
  location, title: path.parse(location).name, artist: 'Avalon', album: 'Psy', genre: 'Psytrance',
  year: 2021, trackNo: 1, length: 412, bitRate: 1411, sampleRate: 44100, bitDepth: 16, fileSize: 70_000_000, fileType: 5, ...over,
});

const row = (table: string, where: string, ...args: unknown[]) => db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...args) as any;
const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as any).n;

describe('applyImport', () => {
  it('writes a track the way rekordbox writes one it has not analysed yet', () => {
    const out = applyImport(db, [track('/dl/Avalon/Psy/Explorers.flac')], [], now, counter());
    expect(out).toMatchObject({ tracksAdded: 1, tracksAlreadyThere: 0 });
    const c = row('djmdContent', 'FolderPath = ?', '/dl/Avalon/Psy/Explorers.flac');
    expect(c).toMatchObject({
      FileNameL: 'Explorers.flac', Title: 'Explorers', ArtistID: '900', Length: 412, BitRate: 1411, BitDepth: 16,
      SampleRate: 44100, FileType: 5, FileSize: 70_000_000, ReleaseYear: 2021, TrackNo: 1,
      MasterDBID: '331342631', DeviceID: 'dev-uuid', ContentLink: 13, KeyID: '0', ColorID: '0',
      HotCueAutoLoad: 'on', DeliveryControl: 'on', VideoAssociate: '0', ExtInfo: 'null', Analysed: 0,
      rb_local_deleted: 0, rb_data_status: 0, usn: null, created_at: '2026-09-30 21:04:20.692 +00:00',
    });
    expect(c.MasterSongID).toBe(c.ID);
    expect(c.AnalysisDataPath).toBeNull();
    expect(c.UUID).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.rb_file_id).not.toBe(c.ID);
  });

  it('uses the artist already there and creates the album and genre', () => {
    applyImport(db, [track('/dl/a.flac')], [], now, counter());
    expect(count('djmdArtist')).toBe(1);
    const album = row('djmdAlbum', 'Name = ?', 'Psy');
    const genre = row('djmdGenre', 'Name = ?', 'Psytrance');
    expect(row('djmdContent', 'FolderPath = ?', '/dl/a.flac')).toMatchObject({ AlbumID: album.ID, GenreID: genre.ID });
    expect(album).toMatchObject({ Compilation: 0, AlbumArtistID: null, rb_local_deleted: 0 });
  });

  it('leaves the artist, album and genre empty rather than creating blank ones', () => {
    applyImport(db, [track('/dl/b.flac', { artist: ' ', album: '', genre: undefined })], [], now, counter());
    expect(row('djmdContent', 'FolderPath = ?', '/dl/b.flac')).toMatchObject({ ArtistID: null, AlbumID: null, GenreID: null });
    expect(count('djmdAlbum') + count('djmdGenre')).toBe(0);
  });

  it('numbers every row from rekordbox\'s update counter, and moves the counter on', () => {
    applyImport(db, [track('/dl/a.flac'), track('/dl/b.flac', { album: 'Psy' })], [{ name: 'Set', locations: ['/dl/a.flac', '/dl/b.flac'] }], now, counter());
    const usns = ['djmdAlbum', 'djmdGenre', 'djmdContent', 'djmdPlaylist', 'djmdSongPlaylist']
      .flatMap((t) => (db.prepare(`SELECT rb_local_usn AS u FROM ${t} WHERE rb_local_usn IS NOT NULL`).all() as any[]).map((r) => r.u))
      .sort((a, b) => a - b);
    // album, genre, 2 tracks, the playlist, 2 links: 1001…1007, no gaps, no repeats.
    expect(usns).toEqual([1001, 1002, 1003, 1004, 1005, 1006, 1007]);
    expect(row('agentRegistry', "registry_id = 'localUpdateCount'").int_1).toBe(1007);
  });

  it('uses a track already in the collection at the same place', () => {
    const out = applyImport(db, [track('/music/existing.mp3')], [{ name: 'Old ones', locations: ['/music/existing.mp3'] }], now, counter());
    expect(out).toMatchObject({ tracksAdded: 0, tracksAlreadyThere: 1 });
    expect(count('djmdContent')).toBe(1);
    expect(row('djmdSongPlaylist', 'ContentID = ?', '800')).toBeTruthy();
  });

  it('makes a playlist at the end of the root, its tracks in order', () => {
    const out = applyImport(db, [track('/dl/1.flac'), track('/dl/2.flac')], [{ name: 'Sunset', locations: ['/dl/2.flac', '/dl/1.flac'] }], now, counter());
    const [created] = out.playlists;
    expect(created).toMatchObject({ name: 'Sunset', tracks: 2, timestamp: now.getTime() });
    expect(row('djmdPlaylist', 'ID = ?', created.id)).toMatchObject({ Seq: 6, ParentID: 'root', Attribute: 0, SmartList: null });
    const songs = db.prepare('SELECT s.TrackNo, c.FolderPath FROM djmdSongPlaylist s JOIN djmdContent c ON c.ID = s.ContentID WHERE s.PlaylistID = ? ORDER BY s.TrackNo').all(created.id);
    expect(songs).toEqual([{ TrackNo: 1, FolderPath: '/dl/2.flac' }, { TrackNo: 2, FolderPath: '/dl/1.flac' }]);
  });

  it('names a playlist apart from one already there, rather than filling that one', () => {
    const out = applyImport(db, [track('/dl/1.flac')], [{ name: 'Peak', locations: ['/dl/1.flac'] }, { name: 'Peak', locations: ['/dl/1.flac'] }], now, counter());
    expect(out.playlists.map((p) => p.name)).toEqual(['Peak (2)', 'Peak (3)']);
    expect(db.prepare("SELECT count(*) AS n FROM djmdSongPlaylist WHERE PlaylistID = '700'").get()).toEqual({ n: 0 });
  });

  it('writes nothing when a playlist names a track that is not there', () => {
    expect(() => applyImport(db, [track('/dl/1.flac')], [{ name: 'Broken', locations: ['/dl/missing.flac'] }], now, counter()))
      .toThrow(/not in the collection/);
    expect(count('djmdContent')).toBe(1);
    expect(row('agentRegistry', "registry_id = 'localUpdateCount'").int_1).toBe(1000);
  });

  it('refuses a database that is not rekordbox\'s', () => {
    db.exec('DELETE FROM djmdDevice');
    expect(() => applyImport(db, [track('/dl/1.flac')], [], now, counter())).toThrow(/does not look like a rekordbox library/);
  });
});

describe('addMasterPlaylistNodes', () => {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '',
    '<MASTER_PLAYLIST Version="3.0.0" AutomaticSync="0">',
    '  <PRODUCT Name="rekordbox" Version="7.1.1" Company="Pioneer DJ"/>',
    '  <PLAYLISTS>',
    '    <NODE Id="2BC" ParentId="0" Attribute="0" Timestamp="0" Lib_Type="0" CheckType="0"/>',
    '  </PLAYLISTS>',
    '</MASTER_PLAYLIST>',
    '',
  ].join('\n');

  it('adds a root NODE per playlist, its ID in hexadecimal, as rekordbox writes them', () => {
    const out = addMasterPlaylistNodes(xml, [{ id: '3884653580', name: 'x', tracks: 1, timestamp: 1790000000000 }]);
    expect(out).toContain('    <NODE Id="E78B1C0C" ParentId="0" Attribute="0" Timestamp="1790000000000" Lib_Type="0" CheckType="0"/>\n  </PLAYLISTS>');
    expect(out.split('\n')).toHaveLength(xml.split('\n').length + 1);
  });

  it('does not add a playlist twice', () => {
    expect(addMasterPlaylistNodes(xml, [{ id: '700', name: 'x', tracks: 1, timestamp: 1 }])).toBe(xml);
  });

  it('refuses a file that is not rekordbox\'s', () => {
    expect(() => addMasterPlaylistNodes('<nope/>', [{ id: '1', name: 'x', tracks: 1, timestamp: 1 }])).toThrow(/no PLAYLISTS/);
  });
});

describe('importIntoDb', () => {
  const makeEncrypted = (file: string, key: string) => {
    const enc = new Database(file);
    unlockDatabase(enc, key);
    enc.exec(SCHEMA);
    enc.exec(SEED);
    enc.close();
  };

  it('backs up, writes into the encrypted database, and lists the playlist for rekordbox', () => {
    const dbPath = path.join(dir, 'master.db');
    makeEncrypted(dbPath, 'k');
    fs.writeFileSync(path.join(dir, 'masterPlaylists6.xml'), '<MASTER_PLAYLIST>\n  <PLAYLISTS>\n  </PLAYLISTS>\n</MASTER_PLAYLIST>\n');
    const backupPath = `${dbPath}.backup.test`;

    const out = importIntoDb(dbPath, 'k', [track('/dl/1.flac')], [{ name: 'Sunset', locations: ['/dl/1.flac'] }], { backupPath, checkRunning: () => false });

    expect(out).toMatchObject({ tracksAdded: 1, playlistFileUpdated: true, backupPath });
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.existsSync(`${backupPath}.masterPlaylists6.xml`)).toBe(true);
    const hex = Number(out.playlists[0].id).toString(16).toUpperCase();
    expect(fs.readFileSync(path.join(dir, 'masterPlaylists6.xml'), 'utf8')).toContain(`<NODE Id="${hex}" ParentId="0"`);
    const check = new Database(dbPath);
    unlockDatabase(check, 'k');
    expect(check.prepare('SELECT Title FROM djmdContent WHERE FolderPath = ?').get('/dl/1.flac')).toEqual({ Title: '1' });
    check.close();
  });

  it('refuses while rekordbox runs, and never writes without a backup', () => {
    const dbPath = path.join(dir, 'master.db');
    makeEncrypted(dbPath, 'k');
    expect(() => importIntoDb(dbPath, 'k', [track('/dl/1.flac')], [], { backupPath: `${dbPath}.b`, checkRunning: () => true })).toThrow(/Close rekordbox/);
    expect(() => importIntoDb(dbPath, 'k', [track('/dl/1.flac')], [], { backupPath: '', checkRunning: () => false })).toThrow(/backup path is required/);
  });

  it('writes nothing when the playlist file is not rekordbox\'s', () => {
    const dbPath = path.join(dir, 'master.db');
    makeEncrypted(dbPath, 'k');
    fs.writeFileSync(path.join(dir, 'masterPlaylists6.xml'), 'garbage');
    expect(() => importIntoDb(dbPath, 'k', [track('/dl/1.flac')], [{ name: 'S', locations: ['/dl/1.flac'] }], { backupPath: `${dbPath}.b`, checkRunning: () => false }))
      .toThrow(/does not look like rekordbox wrote it/);
    expect(fs.existsSync(`${dbPath}.b`)).toBe(false);
  });
});
