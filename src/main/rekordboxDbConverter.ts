import Database from 'better-sqlite3-multiple-ciphers';
import * as fs from 'fs';
import * as path from 'path';
import { unlockDatabase } from './rekordboxDbParser';
import { backupDatabaseFile } from './backupDatabase';
import { isRekordboxRunning } from './rekordboxRunning';
import { nextUsn } from './rekordboxDbRelocator';
import type { ConversionFormat } from './flacConverter';

type Db = InstanceType<typeof Database>;

/**
 * rekordbox's `djmdContent.FileType` codes, as pyrekordbox documents them.
 * The type decides how rekordbox and an exported USB describe the file, so a
 * track pointed at an AIFF while still marked FLAC is refused by the very
 * players the conversion is for.
 */
export const REKORDBOX_FILE_TYPE: Record<ConversionFormat, number> = { mp3: 1, wav: 11, aiff: 12 };

/** One entry that now has a converted file, and what that file is. */
export interface ConversionWritePlan {
  trackId: string;
  /** Where the entry pointed when the library was read. */
  oldLocation: string;
  newLocation: string;
  format: ConversionFormat;
  size: number;
  sampleRate: number;
  bitDepth: number;
  bitRate: number;
}

export interface ConversionWriteSkip {
  trackId: string;
  reason: string;
}

export interface ConversionWriteOutcome {
  tracksUpdated: number;
  skipped: ConversionWriteSkip[];
  backupPath: string;
}

export interface ConversionWriteOptions {
  backupPath: string;
  checkRunning?: () => boolean;
  /** Injectable so the database work can be tested without touching the disk. */
  isRegularFile?: (p: string) => boolean;
}

const realIsRegularFile = (p: string): boolean => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

const samePath = (a: string, b: string) => a.normalize('NFC') === b.normalize('NFC');

/**
 * Point converted tracks at their new files inside rekordbox's own database.
 *
 * This is a relocation that also changes what the file is: the path moves
 * as it does when a track is relocated, and the type, size, bit rate, depth
 * and sample rate follow the new file. Everything keyed by the track's id —
 * cues, loops, beatgrid, playlists, play history — stays attached. For AIFF
 * and WAV the conversion is sample-exact, so it all still lines up; for MP3
 * a cue can land a few milliseconds late on a player that ignores the
 * encoder's gapless header.
 *
 * Same refusals as every other write: rekordbox must be closed, and a
 * verified backup is taken before the database is opened for writing.
 */
export function writeConversionsToDb(
  dbPath: string,
  key: string,
  plans: ConversionWritePlan[],
  options: ConversionWriteOptions
): ConversionWriteOutcome {
  const running = options.checkRunning ?? isRekordboxRunning;
  if (running()) {
    throw new Error('Close rekordbox first — it keeps the database open, and writing while it runs risks losing the change.');
  }
  if (!options.backupPath) {
    throw new Error('A backup path is required; this never writes without one.');
  }

  backupDatabaseFile(dbPath, options.backupPath);

  let db: Db | null = null;
  try {
    db = new Database(dbPath);
    unlockDatabase(db, key);
    const outcome = applyConversions(db, plans, options.isRegularFile ?? realIsRegularFile);
    return { ...outcome, backupPath: options.backupPath };
  } finally {
    if (db) { db.close(); }
  }
}

/**
 * The database work itself, separated so it can be tested without encryption.
 *
 * An entry is re-read before it changes. If it no longer points at the file
 * that was converted — relocated in rekordbox since the library was loaded,
 * say — it is left alone: re-pointing it would swap one recording for another.
 */
export function applyConversions(
  db: Db,
  plans: ConversionWritePlan[],
  isRegularFile: (p: string) => boolean = realIsRegularFile
): { tracksUpdated: number; skipped: ConversionWriteSkip[] } {
  const readTrack = db.prepare('SELECT FolderPath AS path FROM djmdContent WHERE ID = ? AND rb_local_deleted = 0');
  const update = db.prepare(`
    UPDATE djmdContent
    SET FolderPath = ?, FileNameL = ?, FileType = ?, FileSize = ?,
        BitRate = ?, BitDepth = ?, SampleRate = ?,
        rb_local_usn = COALESCE(?, rb_local_usn)
    WHERE ID = ?
  `);

  const skipped: ConversionWriteSkip[] = [];
  let tracksUpdated = 0;

  const run = db.transaction((allPlans: ConversionWritePlan[]) => {
    for (const plan of allPlans) {
      const row = readTrack.get(plan.trackId) as { path?: string | null } | undefined;
      if (!row) {
        skipped.push({ trackId: plan.trackId, reason: 'not in the collection' });
        continue;
      }
      if (!samePath(row.path ?? '', plan.oldLocation)) {
        skipped.push({ trackId: plan.trackId, reason: 'it points at a different file than when the library was loaded' });
        continue;
      }
      if (!isRegularFile(plan.newLocation)) {
        skipped.push({ trackId: plan.trackId, reason: 'the converted file is not there' });
        continue;
      }
      tracksUpdated += update.run(
        plan.newLocation,
        path.basename(plan.newLocation),
        REKORDBOX_FILE_TYPE[plan.format],
        plan.size,
        plan.bitRate,
        plan.bitDepth,
        plan.sampleRate,
        nextUsn(db),
        plan.trackId
      ).changes;
    }
  });
  run(plans);

  return { tracksUpdated, skipped };
}
