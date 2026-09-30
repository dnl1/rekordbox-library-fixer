import Database from 'better-sqlite3-multiple-ciphers';
import * as fs from 'fs';
import { unlockDatabase } from './rekordboxDbParser';
import { backupDatabaseFile } from './backupDatabase';
import { isRekordboxRunning } from './rekordboxRunning';
import { isStreamingLocation } from './brokenEntries';
import { isHostFile, keeperProblem } from './keeperGuard';

type Db = InstanceType<typeof Database>;

/** One duplicate set: the entry to keep, and the extra entries to retire. */
export interface MergePlan {
  keepId: string;
  removeIds: string[];
}

export interface MergeOutcome {
  entriesRemoved: number;
  playlistLinksMoved: number;
  /** Plays of a retired copy in rekordbox's History, now pointing at the kept entry. */
  historyEntriesMoved: number;
  backupPath: string;
  /** Where the removed entries pointed, so their files can be trashed if asked. */
  removedLocations: string[];
  /** Every location still in the collection after the merge — those files must stay. */
  remainingLocations: string[];
  /** Sets left untouched because merging them could lose the only audio file. */
  skipped: Array<{ keepId: string; reason: string }>;
}

/**
 * Retire duplicate collection entries inside rekordbox's own database.
 *
 * What changes, all of it undone by restoring the backup:
 *  - playlist links pointing at a retired entry are moved to the kept entry,
 *    so no playlist loses the song;
 *  - the retired entry's plays in rekordbox's History are moved to the kept
 *    entry too, so no set loses a track it played;
 *  - the retired entries are removed, with the rows other tables hold for them.
 *
 * Rows are marked rather than deleted on purpose: thirteen tables reference a
 * track (cues, mixer params, history, sampler...) and hard deletion would
 * either orphan them or require touching all of them. Marking leaves every
 * relation intact and can be undone by restoring the backup.
 *
 * No audio file is touched here. This only edits rekordbox's catalogue; the
 * caller trashes files, if asked, from what the outcome says was removed.
 */
export function mergeDuplicateEntries(
  dbPath: string,
  key: string,
  plans: MergePlan[],
  options: { backupPath: string; checkRunning?: () => boolean; isFile?: (p: string) => boolean } = { backupPath: '' }
): MergeOutcome {
  const running = options.checkRunning ?? isRekordboxRunning;
  if (running()) {
    throw new Error('Close rekordbox first — it keeps the database open, and writing while it runs risks losing the change.');
  }
  if (!options.backupPath) {
    throw new Error('A backup path is required; this never writes without one.');
  }

  // Back up before opening for writing, and verify the copy before going on.
  backupDatabaseFile(dbPath, options.backupPath);

  let db: Db | null = null;
  try {
    db = new Database(dbPath);
    unlockDatabase(db, key);
    return applyMerges(db, plans, options.isFile ?? isHostFile);
  } finally {
    if (db) { db.close(); }
  }
}

/**
 * Tables that reference a track. Every one must lose its rows, or rekordbox is
 * left with cues, mixer settings and history pointing at a track that is gone.
 */
const CONTENT_TABLES = [
  'contentActiveCensor', 'contentCue', 'contentFile', 'djmdActiveCensor',
  'djmdCue', 'djmdMixerParam', 'djmdSongHistory', 'djmdSongHotCueBanklist',
  'djmdSongMyTag', 'djmdSongPlaylist', 'djmdSongRelatedTracks',
  'djmdSongSampler', 'djmdSongTagList',
];

/** Rekordbox counts every change; sync and its own bookkeeping rely on it. */
function bumpUpdateCount(db: Db, by: number): void {
  if (by <= 0) { return; }
  try {
    db.prepare(
      "UPDATE agentRegistry SET int_1 = COALESCE(int_1, 0) + ? WHERE registry_id = 'localUpdateCount'"
    ).run(by);
  } catch {
    // An older schema may not have the counter; the delete itself still stands.
  }
}

/**
 * The database work itself, separated so it can be tested without encryption.
 *
 * Rows are really deleted, not flagged: marking `rb_local_deleted` left the
 * tracks visible in rekordbox, which is the whole point of the exercise.
 * pyrekordbox deletes for the same reason and keeps the update counter in step.
 */
export function applyMerges(
  db: Db,
  plans: MergePlan[],
  /** Checks a stored location is a file; the default trusts every one. */
  isFile: (p: string) => boolean = () => true
): MergeOutcome {
  const movePlaylistLink = db.prepare(`
    UPDATE djmdSongPlaylist SET ContentID = ?
    WHERE ContentID = ?
      AND PlaylistID NOT IN (
        SELECT PlaylistID FROM djmdSongPlaylist WHERE ContentID = ?
      )
  `);
  const dropRemainingLinks = db.prepare('DELETE FROM djmdSongPlaylist WHERE ContentID = ?');
  const deleteContent = db.prepare('DELETE FROM djmdContent WHERE ID = ?');
  const readLocation = db.prepare('SELECT FolderPath AS path FROM djmdContent WHERE ID = ?');
  // Every play of a retired copy was a play of the song, so all of them follow
  // the kept entry — unlike a playlist, a set may hold the song twice. Deleting
  // them emptied whole sets out of rekordbox's History.
  const moveHistory = (() => {
    try { return db.prepare('UPDATE djmdSongHistory SET ContentID = ? WHERE ContentID = ?'); }
    catch { return null; }
  })();

  const dependentDeletes = CONTENT_TABLES
    .filter((table) => table !== 'djmdSongPlaylist' && table !== 'djmdSongHistory')
    .map((table) => {
      try { return db.prepare(`DELETE FROM ${table} WHERE ContentID = ?`); }
      catch { return null; }
    })
    .filter((stmt): stmt is ReturnType<Db['prepare']> => stmt !== null);

  let entriesRemoved = 0;
  let playlistLinksMoved = 0;
  let historyEntriesMoved = 0;
  const removedLocations: string[] = [];
  const skipped: Array<{ keepId: string; reason: string }> = [];
  const locationOf = (id: string) => (readLocation.get(id) as { path?: string } | undefined)?.path;

  const run = db.transaction((allPlans: MergePlan[]) => {
    for (const plan of allPlans) {
      const problem = keeperProblem(
        locationOf(plan.keepId),
        plan.removeIds.filter((id) => id !== plan.keepId).map(locationOf),
        isFile
      );
      if (problem) { skipped.push({ keepId: plan.keepId, reason: problem }); continue; }
      for (const removeId of plan.removeIds) {
        if (removeId === plan.keepId) { continue; }
        const location = locationOf(removeId);
        // Playlists holding only this copy follow the kept entry; the rest
        // would duplicate an existing link, so they go.
        playlistLinksMoved += movePlaylistLink.run(plan.keepId, removeId, plan.keepId).changes;
        dropRemainingLinks.run(removeId);
        historyEntriesMoved += moveHistory?.run(plan.keepId, removeId).changes ?? 0;
        for (const stmt of dependentDeletes) { stmt.run(removeId); }
        const removed = deleteContent.run(removeId).changes;
        entriesRemoved += removed;
        if (removed > 0 && location) { removedLocations.push(location); }
      }
    }
    bumpUpdateCount(db, entriesRemoved + playlistLinksMoved + historyEntriesMoved);
  });
  run(plans);

  const remainingLocations = (db.prepare('SELECT FolderPath AS path FROM djmdContent').all() as Array<{ path?: string }>)
    .map((row) => row.path ?? '')
    .filter((loc) => loc.length > 0);

  return { entriesRemoved, playlistLinksMoved, historyEntriesMoved, backupPath: '', removedLocations, remainingLocations, skipped };
}

export interface RemovalOutcome {
  entriesRemoved: number;
  playlistLinksRemoved: number;
  /** Entries left alone, with the reason — an id whose file turned out to be there. */
  kept: Array<{ trackId: string; reason: string }>;
  backupPath: string;
}

/**
 * Remove collection entries from rekordbox's own database.
 *
 * This exists for entries that can never resolve to a file: folders, paths cut
 * short by a bad import, locations that are empty, and files that are simply
 * gone for good. No audio file is touched — there is none to touch.
 *
 * Every id is checked against the database before it goes: an entry whose file
 * is actually there is kept, whatever the caller asked for. A stale list from
 * the renderer, or a drive that was unmounted during the scan and is back now,
 * must not cost the DJ a real track with its cues and playlist slots.
 */
export function removeEntriesFromDb(
  dbPath: string,
  key: string,
  trackIds: string[],
  options: { backupPath: string; checkRunning?: () => boolean; fileExists?: (p: string) => boolean }
): RemovalOutcome {
  const running = options.checkRunning ?? isRekordboxRunning;
  if (running()) {
    throw new Error('Close rekordbox first — it keeps the database open, and writing while it runs risks losing the change.');
  }
  if (!options.backupPath) {
    throw new Error('A backup path is required; this never writes without one.');
  }

  // Back up before opening for writing, and verify the copy before going on.
  backupDatabaseFile(dbPath, options.backupPath);

  let db: Db | null = null;
  try {
    db = new Database(dbPath);
    unlockDatabase(db, key);
    const outcome = applyEntryRemoval(db, trackIds, options.fileExists ?? fs.existsSync);
    return { ...outcome, backupPath: options.backupPath };
  } finally {
    if (db) { db.close(); }
  }
}

/**
 * The database work itself, separated so it can be tested without encryption.
 *
 * An entry survives when its file is there, and when it is a streaming track:
 * a TIDAL or Spotify entry has no file by design and is not damaged at all.
 */
export function applyEntryRemoval(
  db: Db,
  trackIds: string[],
  fileExists: (p: string) => boolean = fs.existsSync
): { entriesRemoved: number; playlistLinksRemoved: number; kept: Array<{ trackId: string; reason: string }> } {
  const readLocation = db.prepare('SELECT FolderPath AS path FROM djmdContent WHERE ID = ?');
  const dropLinks = db.prepare('DELETE FROM djmdSongPlaylist WHERE ContentID = ?');
  const deleteContent = db.prepare('DELETE FROM djmdContent WHERE ID = ?');

  const dependentDeletes = CONTENT_TABLES
    .filter((table) => table !== 'djmdSongPlaylist')
    .map((table) => {
      try { return db.prepare(`DELETE FROM ${table} WHERE ContentID = ?`); }
      catch { return null; }
    })
    .filter((stmt): stmt is ReturnType<Db['prepare']> => stmt !== null);

  let entriesRemoved = 0;
  let playlistLinksRemoved = 0;
  const kept: Array<{ trackId: string; reason: string }> = [];

  const run = db.transaction((ids: string[]) => {
    for (const trackId of ids) {
      const row = readLocation.get(trackId) as { path?: string } | undefined;
      if (!row) { kept.push({ trackId, reason: 'not in the collection' }); continue; }

      const location = (row.path ?? '').trim();
      if (isStreamingLocation(location)) {
        kept.push({ trackId, reason: 'a streaming track, which has no file by design' });
        continue;
      }
      if (location && fileExists(location)) {
        kept.push({ trackId, reason: 'its file is there after all' });
        continue;
      }

      // Nothing can inherit these playlist slots — the entry points at no file,
      // so the links go rather than moving to another track.
      playlistLinksRemoved += dropLinks.run(trackId).changes;
      for (const stmt of dependentDeletes) { stmt.run(trackId); }
      entriesRemoved += deleteContent.run(trackId).changes;
    }
    bumpUpdateCount(db, entriesRemoved + playlistLinksRemoved);
  });
  run(trackIds);

  return { entriesRemoved, playlistLinksRemoved, kept };
}
