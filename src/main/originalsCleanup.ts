import * as fs from 'fs';
import * as path from 'path';
import { isStreamingLocation } from './brokenEntries';
import { SOURCE_KINDS, type CancelToken } from './audioConverter';
import { runPool } from './workerPool';

/**
 * Find the originals a conversion already replaced, and put them in the trash.
 *
 * A conversion run without "move the originals to the trash" — or one done by
 * another tool — leaves `Track.flac`, `Track.wav` or `Track.m4a` beside the
 * `Track.aiff` the library now uses. The original is dead weight, and on a USB
 * stick or a nearly full drive a lot of it. It may go only when three things hold:
 *
 * - no entry in the collection points at it — an entry that does still needs
 *   it, and converting that entry is the Convert tool's job;
 * - an entry points at the AIFF or WAV beside it, so the song is still there;
 * - the two decode to the same audio, sample for sample. The same name is not
 *   proof: a hand-made AIFF of another mix, a different master, would pass it.
 */

/** Extensions a lossless conversion can have. MP3 is never proof of anything. */
const CONVERTED_EXTENSIONS = new Set(['.aiff', '.aif', '.wav']);

/** What Convert audio reads, and so what can be left behind beside its output. */
const ORIGINAL_EXTENSIONS = SOURCE_KINDS.map((kind) => `.${kind}`);

export interface CleanupTrack {
  id: string;
  location: string;
}

/** An original no entry uses, beside the lossless file entries do use. */
export interface CleanupCandidate {
  original: string;
  converted: string;
  /** The entries that point at `converted`. */
  trackIds: string[];
}

export interface CleanupPlan {
  candidates: CleanupCandidate[];
  /** Originals beside a conversion that an entry still points at — left for Convert. */
  stillUsed: number;
}

/** Compared as `computeDeletablePaths` compares: one file, however it is spelled. */
const pathKey = (p: string) => (p ?? '').normalize('NFC').toLowerCase();

/**
 * The originals beside a converted file: `Track.flac`, `Track.wav` or
 * `Track.m4a` beside `Track.aiff`. A WAV is not its own original, so beside
 * `Track.wav` only a FLAC or an M4A counts. Only the extension changes; the
 * path is not rebuilt, for the reason `convertedPath` gives.
 */
export function originalsBeside(location: string, exists: (p: string) => boolean = fs.existsSync): string[] {
  const ext = path.extname(location);
  if (!CONVERTED_EXTENSIONS.has(ext.toLowerCase())) { return []; }
  const stem = location.slice(0, location.length - ext.length);
  const found: string[] = [];
  for (const originalExt of ORIGINAL_EXTENSIONS) {
    if (originalExt === ext.toLowerCase()) { continue; }
    const candidate = [`${stem}${originalExt}`, `${stem}${originalExt.toUpperCase()}`].find(exists);
    if (candidate) { found.push(candidate); }
  }
  return found;
}

/**
 * Decide which originals are candidates. Nothing here proves them identical —
 * that takes decoding both — it only rules out what can never go.
 */
export function planOriginalsCleanup(
  tracks: CleanupTrack[],
  exists: (p: string) => boolean = fs.existsSync
): CleanupPlan {
  const used = new Set(tracks.map((t) => pathKey(t.location)).filter(Boolean));
  const candidates = new Map<string, CleanupCandidate>();
  const stillUsed = new Set<string>();

  for (const track of tracks) {
    const location = (track.location || '').trim();
    if (!location || isStreamingLocation(location)) { continue; }
    const originals = originalsBeside(location, exists);
    if (originals.length === 0 || !exists(location)) { continue; }

    for (const original of originals) {
      const key = pathKey(original);
      if (used.has(key)) { stillUsed.add(key); continue; }
      const existing = candidates.get(key);
      if (existing) {
        if (!existing.trackIds.includes(track.id)) { existing.trackIds.push(track.id); }
        continue;
      }
      candidates.set(key, { original, converted: location, trackIds: [track.id] });
    }
  }

  return { candidates: [...candidates.values()], stillUsed: stillUsed.size };
}

export interface CleanupProgress {
  current: number;
  total: number;
  /** Workers busy right now. */
  active: number;
  currentFile: string;
}

export interface CleanupOutcome {
  trashed: string[];
  freedBytes: number;
  /** Candidates that stay, and why — not the same recording, or used again since. */
  kept: Array<{ file: string; reason: string }>;
  failed: Array<{ file: string; error: string }>;
  cancelled: boolean;
}

export interface CleanupDeps {
  /** Why the two files are not the same audio, or null when they are. */
  sameAudio: (original: string, converted: string, cancelToken: CancelToken) => Promise<string | null>;
  /**
   * Where the collection's entries point now, read after the checks — which
   * can take many minutes, time enough to relocate a track in rekordbox.
   */
  currentLocations: () => Promise<string[]>;
  trash: (file: string) => Promise<void>;
  size?: (file: string) => number;
}

const statSize = (file: string): number => {
  try { return fs.statSync(file).size; } catch { return 0; }
};

/**
 * Check every candidate, re-read the collection, and trash what still
 * qualifies. The trash, never unlink: a wrong call stays recoverable.
 *
 * A cancelled run trashes nothing — not even what it already proved — so a
 * cancel is always safe to press.
 */
export async function trashConvertedOriginals(
  plan: CleanupPlan,
  deps: CleanupDeps,
  onProgress: (p: CleanupProgress) => void,
  cancelToken: CancelToken,
  workers = 1
): Promise<CleanupOutcome> {
  const outcome: CleanupOutcome = { trashed: [], freedBytes: 0, kept: [], failed: [], cancelled: false };
  const total = plan.candidates.length;
  let started = 0;
  let active = 0;
  let currentFile = '';
  const report = () => onProgress({ current: started, total, active, currentFile });

  // The comparisons run `workers` at a time; the trashing below stays one by one.
  const verdicts = await runPool(plan.candidates, workers, async (candidate) => {
    started++;
    currentFile = path.basename(candidate.original);
    report();
    try {
      const problem = await deps.sameAudio(candidate.original, candidate.converted, cancelToken);
      if (problem) {
        outcome.kept.push({ file: candidate.original, reason: `not the same audio as ${path.basename(candidate.converted)} (${problem})` });
        return false;
      }
      return true;
    } catch (error) {
      if (!cancelToken.cancelled) {
        outcome.failed.push({ file: candidate.original, error: error instanceof Error ? error.message : String(error) });
      }
      return false;
    }
  }, cancelToken, (n) => { active = n; if (started > 0) { report(); } });
  if (cancelToken.cancelled) { outcome.cancelled = true; return outcome; }
  const proved = plan.candidates.filter((_, i) => verdicts[i] === true);
  if (proved.length === 0) { return outcome; }

  const now = new Set((await deps.currentLocations()).map(pathKey));
  const size = deps.size ?? statSize;
  for (const candidate of proved) {
    if (now.has(pathKey(candidate.original))) {
      outcome.kept.push({ file: candidate.original, reason: 'an entry points at it now' });
      continue;
    }
    if (!now.has(pathKey(candidate.converted))) {
      outcome.kept.push({ file: candidate.original, reason: `no entry points at ${path.basename(candidate.converted)} any more` });
      continue;
    }
    const bytes = size(candidate.original);
    try {
      await deps.trash(candidate.original);
      outcome.trashed.push(candidate.original);
      outcome.freedBytes += bytes;
    } catch (error) {
      outcome.failed.push({ file: candidate.original, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }
  return outcome;
}
