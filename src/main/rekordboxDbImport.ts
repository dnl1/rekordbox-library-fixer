import Database from 'better-sqlite3-multiple-ciphers';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { unlockDatabase } from './rekordboxDbParser';
import { backupDatabaseFile } from './backupDatabase';
import { isRekordboxRunning } from './rekordboxRunning';
import { rekordboxTimestamp } from './rekordboxDbHotCues';

type Db = InstanceType<typeof Database>;

/**
 * New tracks, and playlists of them, written into rekordbox's own database —
 * the tracks a Navidrome import downloaded.
 *
 * Each row is written as rekordbox and pyrekordbox write one, checked against
 * a real rekordbox 7 library:
 * - `djmdContent`: a 28-bit random ID, `MasterSongID` equal to it,
 *   `MasterDBID` and `DeviceID` from `djmdDevice`, `ContentLink` from the
 *   TRACK row of `djmdMenuItems`, `KeyID` and `ColorID` '0', `HotCueAutoLoad`
 *   and `DeliveryControl` 'on', `ExtInfo` 'null', and `Analysed` 0 with no
 *   analysis path: rekordbox analyses the track itself and fills in the BPM,
 *   the key, the beatgrid and the waveform.
 * - Artist, album and genre are found by name or created.
 * - A playlist is a `djmdPlaylist` row at the end of the root, one
 *   `djmdSongPlaylist` row per track in order, and a NODE in
 *   `masterPlaylists6.xml` beside the database — without it rekordbox may not
 *   show the playlist.
 * - Every row gets the next number of rekordbox's local update counter as its
 *   `rb_local_usn`, and the counter ends on the last one.
 */

export interface ImportTrack {
  /** Absolute path of the downloaded file. */
  location: string;
  title: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: number;
  trackNo?: number;
  discNo?: number;
  /** Seconds. */
  length?: number;
  bitRate?: number;
  sampleRate?: number;
  bitDepth?: number;
  fileSize: number;
  /** `djmdContent.FileType`: 1 mp3, 4 m4a, 5 flac, 11 wav, 12 aiff. */
  fileType: number;
}

export interface ImportPlaylist {
  name: string;
  /** Locations of its tracks, in order; each must be among the imported tracks or already in the collection. */
  locations: string[];
}

export interface CreatedPlaylist {
  id: string;
  name: string;
  tracks: number;
  /** Milliseconds since the epoch, as `masterPlaylists6.xml` stores it. */
  timestamp: number;
}

export interface ImportOutcome {
  tracksAdded: number;
  /** Already in the collection at the same location: used as they are. */
  tracksAlreadyThere: number;
  playlists: CreatedPlaylist[];
}

const MAX_28_BIT = 2 ** 28;

/** A random 28-bit ID of at least 100 that `taken` does not know, as pyrekordbox makes them. */
function freshId(taken: (id: string) => boolean, rand: () => number): string {
  for (let i = 0; i < 1000; i++) {
    const id = String(rand());
    if (!taken(id)) { return id; }
  }
  throw new Error('Could not find an unused ID');
}

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The database work itself, separated so it can be tested without encryption. Runs in one transaction. */
export function applyImport(
  db: Db,
  tracks: ImportTrack[],
  playlists: ImportPlaylist[],
  now: Date = new Date(),
  rand: () => number = () => crypto.randomInt(100, MAX_28_BIT),
): ImportOutcome {
  const device = db.prepare('SELECT ID, MasterDBID FROM djmdDevice LIMIT 1').get() as { ID: string; MasterDBID: string } | undefined;
  if (!device) { throw new Error('This database has no device row — it does not look like a rekordbox library.'); }
  const menu = db.prepare("SELECT rb_local_usn AS usn FROM djmdMenuItems WHERE Name = 'TRACK'").get() as { usn: number | null } | undefined;
  if (!menu) { throw new Error('This database has no TRACK menu row — it does not look like a rekordbox library.'); }
  const counter = db.prepare("SELECT int_1 AS n FROM agentRegistry WHERE registry_id = 'localUpdateCount'").get() as { n: number | null } | undefined;
  if (!counter) { throw new Error('This database has no update counter — it does not look like a rekordbox library.'); }

  const stamp = rekordboxTimestamp(now);
  const today = localDate(now);
  let usn = counter.n ?? 0;
  const nextUsn = () => ++usn;

  const idTaken = (table: string, column = 'ID') => {
    const stmt = db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`);
    return (id: string) => stmt.get(id) !== undefined;
  };
  const contentIdTaken = idTaken('djmdContent');
  const fileIdTaken = idTaken('djmdContent', 'rb_file_id');

  const findByName = (table: string) => {
    const stmt = db.prepare(`SELECT ID FROM ${table} WHERE Name = ? AND rb_local_deleted = 0 LIMIT 1`);
    return (name: string) => (stmt.get(name) as { ID: string } | undefined)?.ID;
  };
  const named = {
    djmdArtist: { find: findByName('djmdArtist'), taken: idTaken('djmdArtist') },
    djmdAlbum: { find: findByName('djmdAlbum'), taken: idTaken('djmdAlbum') },
    djmdGenre: { find: findByName('djmdGenre'), taken: idTaken('djmdGenre') },
  };
  const insertArtist = db.prepare(`INSERT INTO djmdArtist (ID, Name, SearchStr, UUID, rb_data_status, rb_local_data_status,
    rb_local_deleted, rb_local_synced, usn, rb_local_usn, created_at, updated_at) VALUES (?, ?, NULL, ?, 0, 0, 0, 0, NULL, ?, ?, ?)`);
  const insertAlbum = db.prepare(`INSERT INTO djmdAlbum (ID, Name, AlbumArtistID, ImagePath, Compilation, SearchStr, UUID,
    rb_data_status, rb_local_data_status, rb_local_deleted, rb_local_synced, usn, rb_local_usn, created_at, updated_at)
    VALUES (?, ?, NULL, NULL, 0, NULL, ?, 0, 0, 0, 0, NULL, ?, ?, ?)`);
  const insertGenre = db.prepare(`INSERT INTO djmdGenre (ID, Name, UUID, rb_data_status, rb_local_data_status,
    rb_local_deleted, rb_local_synced, usn, rb_local_usn, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 0, 0, NULL, ?, ?, ?)`);
  const inserters = { djmdArtist: insertArtist, djmdAlbum: insertAlbum, djmdGenre: insertGenre };

  const findOrCreate = (table: keyof typeof named, name: string | undefined): string | null => {
    const text = (name ?? '').trim();
    if (!text) { return null; }
    const existing = named[table].find(text);
    if (existing) { return existing; }
    const id = freshId(named[table].taken, rand);
    inserters[table].run(id, text, crypto.randomUUID(), nextUsn(), stamp, stamp);
    return id;
  };

  const findContent = db.prepare('SELECT ID FROM djmdContent WHERE FolderPath = ? AND rb_local_deleted = 0 LIMIT 1');
  const insertContent = db.prepare(`INSERT INTO djmdContent (
      ID, FolderPath, FileNameL, Title, ArtistID, AlbumID, GenreID, Length, TrackNo, BitRate, BitDepth, FileType,
      ReleaseYear, KeyID, StockDate, ColorID, MasterDBID, MasterSongID, FileSize, DiscNo, SampleRate, Analysed,
      DateCreated, ContentLink, HotCueAutoLoad, DeliveryControl, VideoAssociate, ExtInfo, rb_file_id, DeviceID, UUID,
      rb_data_status, rb_local_data_status, rb_local_deleted, rb_local_synced, usn, rb_local_usn, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?, '0', ?, ?, ?, ?, ?, 0, ?, ?, 'on', 'on', '0', 'null', ?, ?, ?,
      0, 0, 0, 0, NULL, ?, ?, ?)`);

  const lastRootSeq = db.prepare("SELECT MAX(Seq) AS seq FROM djmdPlaylist WHERE ParentID = 'root' AND rb_local_deleted = 0");
  const rootNameTaken = db.prepare("SELECT 1 FROM djmdPlaylist WHERE ParentID = 'root' AND Name = ? AND rb_local_deleted = 0");
  const playlistIdTaken = idTaken('djmdPlaylist');
  const insertPlaylist = db.prepare(`INSERT INTO djmdPlaylist (ID, Seq, Name, ImagePath, Attribute, ParentID, SmartList, UUID,
    rb_data_status, rb_local_data_status, rb_local_deleted, rb_local_synced, usn, rb_local_usn, created_at, updated_at)
    VALUES (?, ?, ?, NULL, 0, 'root', NULL, ?, 0, 0, 0, 0, NULL, ?, ?, ?)`);
  const insertSong = db.prepare(`INSERT INTO djmdSongPlaylist (ID, PlaylistID, ContentID, TrackNo, UUID, rb_data_status,
    rb_local_data_status, rb_local_deleted, rb_local_synced, usn, rb_local_usn, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, ?, ?, ?)`);
  const saveCounter = db.prepare("UPDATE agentRegistry SET int_1 = ? WHERE registry_id = 'localUpdateCount'");

  const run = db.transaction((): ImportOutcome => {
    const outcome: ImportOutcome = { tracksAdded: 0, tracksAlreadyThere: 0, playlists: [] };
    const contentByLocation = new Map<string, string>();

    for (const track of tracks) {
      if (contentByLocation.has(track.location)) { continue; }
      const existing = (findContent.get(track.location) as { ID: string } | undefined)?.ID;
      if (existing) {
        contentByLocation.set(track.location, existing);
        outcome.tracksAlreadyThere++;
        continue;
      }
      const artistId = findOrCreate('djmdArtist', track.artist);
      const albumId = findOrCreate('djmdAlbum', track.album);
      const genreId = findOrCreate('djmdGenre', track.genre);
      const id = freshId(contentIdTaken, rand);
      insertContent.run(
        id, track.location, path.basename(track.location), track.title || path.parse(track.location).name,
        artistId, albumId, genreId, track.length ?? null, track.trackNo ?? null, track.bitRate ?? null,
        track.bitDepth ?? null, track.fileType, track.year ?? null, today, device.MasterDBID, id, track.fileSize,
        track.discNo ?? null, track.sampleRate ?? null, today, menu.usn ?? 0, freshId(fileIdTaken, rand), device.ID,
        crypto.randomUUID(), nextUsn(), stamp, stamp,
      );
      contentByLocation.set(track.location, id);
      outcome.tracksAdded++;
    }

    for (const playlist of playlists) {
      const contentIds = playlist.locations.map((loc) => {
        const id = contentByLocation.get(loc) ?? (findContent.get(loc) as { ID: string } | undefined)?.ID;
        if (!id) { throw new Error(`A track of "${playlist.name}" is not in the collection: ${loc}`); }
        return id;
      });
      // A second import of the same playlist is a new playlist, not a merge into the first.
      let name = playlist.name.trim() || 'Navidrome playlist';
      for (let n = 2; rootNameTaken.get(name); n++) { name = `${playlist.name.trim() || 'Navidrome playlist'} (${n})`; }
      const id = freshId(playlistIdTaken, rand);
      const seq = ((lastRootSeq.get() as { seq: number | null }).seq ?? 0) + 1;
      insertPlaylist.run(id, seq, name, crypto.randomUUID(), nextUsn(), stamp, stamp);
      contentIds.forEach((contentId, i) => {
        insertSong.run(crypto.randomUUID(), id, contentId, i + 1, crypto.randomUUID(), nextUsn(), stamp, stamp);
      });
      outcome.playlists.push({ id, name, tracks: contentIds.length, timestamp: now.getTime() });
    }

    saveCounter.run(usn);
    return outcome;
  });
  return run();
}

/**
 * `masterPlaylists6.xml` with a NODE for each new playlist, at the root.
 * rekordbox keeps this file beside the database and lists playlists from it;
 * the Id is the playlist's ID in upper-case hexadecimal.
 */
export function addMasterPlaylistNodes(xml: string, playlists: CreatedPlaylist[]): string {
  const close = xml.lastIndexOf('</PLAYLISTS>');
  if (close < 0) { throw new Error('masterPlaylists6.xml has no PLAYLISTS element'); }
  const indent = /\n([ \t]*)<NODE /.exec(xml)?.[1] ?? '    ';
  const nodes = playlists
    .map((p) => ({ ...p, hex: Number(p.id).toString(16).toUpperCase() }))
    .filter((p) => !xml.includes(`Id="${p.hex}"`))
    .map((p) => `${indent}<NODE Id="${p.hex}" ParentId="0" Attribute="0" Timestamp="${p.timestamp}" Lib_Type="0" CheckType="0"/>\n`)
    .join('');
  if (!nodes) { return xml; }
  // Insert right after the last NODE's line, so the closing tag keeps its indentation.
  const lineStart = xml.lastIndexOf('\n', close) + 1;
  return xml.slice(0, lineStart) + nodes + xml.slice(lineStart);
}

export interface DbImportOptions {
  backupPath: string;
  checkRunning?: () => boolean;
}

export interface DbImportSummary extends ImportOutcome {
  backupPath: string;
  /** False when there were playlists but masterPlaylists6.xml could not be updated. */
  playlistFileUpdated: boolean;
  playlistFileProblem?: string;
}

/** Same refusals as every other write: rekordbox closed, and a verified backup first. */
export function importIntoDb(
  dbPath: string,
  key: string,
  tracks: ImportTrack[],
  playlists: ImportPlaylist[],
  options: DbImportOptions,
): DbImportSummary {
  const running = options.checkRunning ?? isRekordboxRunning;
  if (running()) {
    throw new Error('Close rekordbox first — it keeps the database open, and writing while it runs risks losing the change.');
  }
  if (!options.backupPath) { throw new Error('A backup path is required; this never writes without one.'); }

  // Read before anything is written: a playlist file that cannot be read stops
  // the import instead of leaving playlists rekordbox will not list.
  const playlistFile = path.join(path.dirname(dbPath), 'masterPlaylists6.xml');
  const playlistXml = playlists.length > 0 && fs.existsSync(playlistFile) ? fs.readFileSync(playlistFile, 'utf8') : null;
  if (playlistXml !== null && !playlistXml.includes('</PLAYLISTS>')) {
    throw new Error('masterPlaylists6.xml does not look like rekordbox wrote it, so no playlists were imported.');
  }

  backupDatabaseFile(dbPath, options.backupPath);
  let db: Db | null = null;
  let outcome: ImportOutcome;
  try {
    db = new Database(dbPath);
    unlockDatabase(db, key);
    outcome = applyImport(db, tracks, playlists);
  } finally {
    if (db) { db.close(); }
  }

  const summary: DbImportSummary = {
    ...outcome, backupPath: options.backupPath, playlistFileUpdated: outcome.playlists.length === 0,
  };
  if (outcome.playlists.length > 0) {
    if (playlistXml === null) {
      summary.playlistFileProblem = 'masterPlaylists6.xml was not found beside the database';
    } else {
      try {
        fs.copyFileSync(playlistFile, `${options.backupPath}.masterPlaylists6.xml`);
        fs.writeFileSync(playlistFile, addMasterPlaylistNodes(playlistXml, outcome.playlists), 'utf8');
        summary.playlistFileUpdated = true;
      } catch (error) {
        summary.playlistFileProblem = error instanceof Error ? error.message : String(error);
      }
    }
  }
  return summary;
}
