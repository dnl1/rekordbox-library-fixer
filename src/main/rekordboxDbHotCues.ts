import Database from 'better-sqlite3-multiple-ciphers';
import * as crypto from 'crypto';
import { unlockDatabase } from './rekordboxDbParser';
import { backupDatabaseFile } from './backupDatabase';
import { isRekordboxRunning } from './rekordboxRunning';
import { HOT_CUE_KINDS, MAX_HOT_CUES } from './autoHotCue';

type Db = InstanceType<typeof Database>;

/**
 * Auto hot cues in rekordbox's database: which tracks may get them, and
 * writing them.
 *
 * The collection's cues live only in `djmdCue` — the ANLZ files' cue tags are
 * empty in the library — so a track with no hot cue row there has none. A row
 * written as below, with rekordbox closed, shows up in rekordbox at its time;
 * that was checked against a real rekordbox 7 library.
 */

export interface HotCueCandidateRow {
  id: string;
  title: string;
  artist: string;
  location: string;
  analysisDataPath: string | null;
}

export interface HotCueCandidates {
  /** Tracks with no hot cue. Memory cues do not count. */
  tracks: HotCueCandidateRow[];
  /** Tracks left out because they have at least one hot cue or hot loop. */
  alreadyCued: number;
}

const HAS_HOT_CUE = 'SELECT 1 FROM djmdCue WHERE ContentID = ? AND Kind > 0 AND rb_local_deleted = 0 LIMIT 1';

export function readHotCueCandidates(db: Db, scopeTrackIds?: string[]): HotCueCandidates {
  const cued = new Set(
    (db.prepare('SELECT DISTINCT ContentID AS id FROM djmdCue WHERE Kind > 0 AND rb_local_deleted = 0').all() as Array<{ id: string | number }>)
      .map((r) => String(r.id))
  );
  const scope = scopeTrackIds ? new Set(scopeTrackIds) : null;
  const rows = db.prepare(`
    SELECT c.ID AS id, c.Title AS title, ar.Name AS artist, c.FolderPath AS location, c.AnalysisDataPath AS adp
    FROM djmdContent c
    LEFT JOIN djmdArtist ar ON ar.ID = c.ArtistID AND ar.rb_local_deleted = 0
    WHERE c.rb_local_deleted = 0
  `).all() as Array<{ id: string | number; title: string | null; artist: string | null; location: string | null; adp: string | null }>;

  const result: HotCueCandidates = { tracks: [], alreadyCued: 0 };
  for (const row of rows) {
    const id = String(row.id);
    if (scope && !scope.has(id)) { continue; }
    if (cued.has(id)) { result.alreadyCued++; continue; }
    result.tracks.push({
      id, title: row.title ?? '', artist: row.artist ?? '', location: row.location ?? '', analysisDataPath: row.adp || null,
    });
  }
  return result;
}

export interface HotCueWrite {
  trackId: string;
  cues: Array<{ kind: number; name: string; ms: number }>;
}

export interface HotCueWriteSkip {
  trackId: string;
  reason: string;
}

export interface HotCueWriteOutcome {
  tracksWritten: number;
  cuesWritten: number;
  skipped: HotCueWriteSkip[];
}

/** rekordbox's timestamp: `2026-09-27 01:58:13.887 +00:00`. */
const rekordboxTimestamp = (date: Date) => date.toISOString().replace('T', ' ').replace('Z', ' +00:00');

/** Why a set of cues must not be written, or null when it may. */
function invalid(cues: HotCueWrite['cues']): string | null {
  if (cues.length === 0) { return 'no cues'; }
  if (cues.length > MAX_HOT_CUES) { return `more than ${MAX_HOT_CUES} cues`; }
  const kinds = new Set<number>();
  for (const cue of cues) {
    if (!(HOT_CUE_KINDS as readonly number[]).includes(cue.kind) || kinds.has(cue.kind)) { return 'a hot cue slot is invalid or used twice'; }
    if (!Number.isFinite(cue.ms) || cue.ms < 0) { return 'a cue time is invalid'; }
    kinds.add(cue.kind);
  }
  return null;
}

/**
 * The database work, separated so it can be tested without encryption.
 *
 * Each track is re-read first: one that got a hot cue since the preview —
 * rekordbox opened meanwhile and a cue set by hand — is left alone, so a cue
 * someone placed is never joined by ones they did not ask for.
 */
export function applyHotCues(db: Db, writes: HotCueWrite[], now: Date = new Date()): HotCueWriteOutcome {
  const readTrack = db.prepare('SELECT UUID AS uuid FROM djmdContent WHERE ID = ? AND rb_local_deleted = 0');
  const hasHotCue = db.prepare(HAS_HOT_CUE);
  const idTaken = db.prepare('SELECT 1 FROM djmdCue WHERE ID = ?');
  const insert = db.prepare(`
    INSERT INTO djmdCue (
      ID, ContentID, InMsec, InFrame, InMpegFrame, InMpegAbs, OutMsec, OutFrame, OutMpegFrame, OutMpegAbs,
      Kind, Color, ColorTableIndex, ActiveLoop, Comment, BeatLoopSize, CueMicrosec, InPointSeekInfo, OutPointSeekInfo,
      ContentUUID, UUID, rb_data_status, rb_local_data_status, rb_local_deleted, rb_local_synced, usn, rb_local_usn,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, 0, -1, 0, 0, 0, ?, -1, NULL, 0, ?, 0, 0, NULL, NULL, ?, ?, 0, 0, 0, 0, NULL, NULL, ?, ?)
  `);

  const outcome: HotCueWriteOutcome = { tracksWritten: 0, cuesWritten: 0, skipped: [] };
  const stamp = rekordboxTimestamp(now);

  const run = db.transaction((all: HotCueWrite[]) => {
    for (const write of all) {
      const problem = invalid(write.cues);
      if (problem) { outcome.skipped.push({ trackId: write.trackId, reason: problem }); continue; }
      const track = readTrack.get(write.trackId) as { uuid: string | null } | undefined;
      if (!track) { outcome.skipped.push({ trackId: write.trackId, reason: 'not in the collection' }); continue; }
      if (hasHotCue.get(write.trackId)) {
        outcome.skipped.push({ trackId: write.trackId, reason: 'it has a hot cue now' });
        continue;
      }
      for (const cue of write.cues) {
        let id: string;
        do { id = String(crypto.randomInt(1, 2 ** 32)); } while (idTaken.get(id));
        const ms = Math.round(cue.ms);
        // rekordbox counts InFrame in 1/150 s units alongside the milliseconds.
        const frame = Math.floor((ms * 150) / 1000);
        insert.run(id, write.trackId, ms, frame, cue.kind, cue.name, track.uuid, crypto.randomUUID(), stamp, stamp);
        outcome.cuesWritten++;
      }
      outcome.tracksWritten++;
    }
  });
  run(writes);
  return outcome;
}

export interface HotCueWriteOptions {
  backupPath: string;
  checkRunning?: () => boolean;
}

/** Same refusals as every other write: rekordbox closed, and a verified backup first. */
export function writeHotCuesToDb(
  dbPath: string,
  key: string,
  writes: HotCueWrite[],
  options: HotCueWriteOptions
): HotCueWriteOutcome & { backupPath: string } {
  const running = options.checkRunning ?? isRekordboxRunning;
  if (running()) {
    throw new Error('Close rekordbox first — it keeps the database open, and writing while it runs risks losing the change.');
  }
  if (!options.backupPath) { throw new Error('A backup path is required; this never writes without one.'); }

  backupDatabaseFile(dbPath, options.backupPath);
  let db: Db | null = null;
  try {
    db = new Database(dbPath);
    unlockDatabase(db, key);
    return { ...applyHotCues(db, writes), backupPath: options.backupPath };
  } finally {
    if (db) { db.close(); }
  }
}
