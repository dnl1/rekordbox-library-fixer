import * as fs from 'fs';
import * as path from 'path';
import { isStreamingLocation } from './brokenEntries';
import { ZipWriter, ZipCancelled } from './zipWriter';
import type { PlaylistZipSummary, TrackPayload } from './ipcContract';

/**
 * A playlist as a zip of its audio files — for sending a set to someone, or
 * carrying it to a player the app does not export to. Only the files: no
 * library, no cues, no folders inside the zip. Whoever unpacks it gets the
 * tracks side by side, as they would from a USB stick's contents.
 */

export interface ZipPlanEntry {
  trackId: string;
  /** Where the file is on this machine's disk. */
  source: string;
  /** Its name inside the zip. */
  name: string;
  size: number;
}

export interface ZipPlan {
  entries: ZipPlanEntry[];
  totalBytes: number;
  skipped: Array<{ trackId: string; location: string; reason: string }>;
}

export interface PlanDeps {
  /** The file's size, or null when it is not there. */
  sizeOf: (hostPath: string) => number | null;
  toHost: (libraryPath: string) => string;
}

/**
 * Characters Windows refuses in a file name. A name from a Mac library can
 * hold a colon, and the zip would then not unpack on Windows at all.
 */
// eslint-disable-next-line no-control-regex
export const safeFileName = (name: string): string => name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');

/**
 * What goes into the zip and under which names, in playlist order.
 *
 * An entry whose file is not there, or a streaming track with no file at
 * all, is skipped and said so. Two entries for one file put it in once. Two
 * different files of one name — `Intro.mp3` from two albums — are told apart
 * as `Intro (2).mp3`, compared without case because the zip may be unpacked
 * on a disk that ignores it. `numbered` puts the playlist position in front
 * of each name, so a folder sorted by name plays in the playlist's order.
 */
export function planPlaylistZip(tracks: TrackPayload[], numbered: boolean, deps: PlanDeps): ZipPlan {
  const entries: ZipPlanEntry[] = [];
  const skipped: ZipPlan['skipped'] = [];
  const seenSources = new Set<string>();
  const takenNames = new Set<string>();
  const width = Math.max(2, String(tracks.length).length);

  for (const track of tracks) {
    const location = track.location ?? '';
    if (!location) { skipped.push({ trackId: track.id, location, reason: 'no file location' }); continue; }
    if (isStreamingLocation(location)) {
      skipped.push({ trackId: track.id, location, reason: 'a streaming track has no file' });
      continue;
    }
    const source = deps.toHost(location);
    const sourceKey = source.normalize('NFC');
    if (seenSources.has(sourceKey)) { continue; }
    const size = deps.sizeOf(source);
    if (size === null) { skipped.push({ trackId: track.id, location, reason: 'file not found' }); continue; }
    seenSources.add(sourceKey);

    // The library may store a Windows path on a machine that splits on "/".
    const base = safeFileName(location.split(/[\\/]/).pop() || `track-${track.id}`).normalize('NFC');
    const prefix = numbered ? `${String(entries.length + 1).padStart(width, '0')} ` : '';
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let name = `${prefix}${base}`;
    for (let n = 2; takenNames.has(name.toLowerCase()); n++) { name = `${prefix}${stem} (${n})${ext}`; }
    takenNames.add(name.toLowerCase());

    entries.push({ trackId: track.id, source, name, size });
  }

  return { entries, totalBytes: entries.reduce((sum, e) => sum + e.size, 0), skipped };
}

export const statSize = (hostPath: string): number | null => {
  try {
    const stat = fs.statSync(hostPath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
};

export interface ZipRunProgress {
  current: number;
  total: number;
  currentFile: string;
  bytesWritten: number;
  totalBytes: number;
}

/**
 * Write the plan to `outputPath`. The zip is built under a `.part` name and
 * renamed only once it is complete, so a cancelled or failed run never
 * leaves something that looks like a finished export. Missing files were
 * already left out by the plan; one that fails while it is being read ends
 * the run, because half of it is already in the zip.
 */
export async function writePlaylistZip(
  plan: ZipPlan,
  outputPath: string,
  onProgress: (p: ZipRunProgress) => void,
  isCancelled: () => boolean,
): Promise<PlaylistZipSummary> {
  const partPath = `${outputPath}.part`;
  const zip = await ZipWriter.create(partPath);
  const skipped = plan.skipped.map(({ location, reason }) => ({ location, reason }));
  let bytesWritten = 0;
  let filesAdded = 0;

  const report = (current: number, currentFile: string) => onProgress({
    current, total: plan.entries.length, currentFile, bytesWritten, totalBytes: plan.totalBytes,
  });

  try {
    for (const [i, entry] of plan.entries.entries()) {
      if (isCancelled()) { throw new ZipCancelled(); }
      report(i, entry.name);
      let lastReport = Date.now();
      try {
        await zip.addFile(entry.source, entry.name, (n) => {
          bytesWritten += n;
          if (Date.now() - lastReport > 200) { lastReport = Date.now(); report(i, entry.name); }
        }, isCancelled);
        filesAdded++;
      } catch (error) {
        if (error instanceof ZipCancelled) { throw error; }
        throw new Error(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await zip.finish();
    await fs.promises.rename(partPath, outputPath);
    report(plan.entries.length, '');
    return { outputPath, filesAdded, bytes: bytesWritten, skipped, cancelled: false };
  } catch (error) {
    await zip.abort();
    await fs.promises.rm(partPath, { force: true });
    if (error instanceof ZipCancelled) {
      return { outputPath, filesAdded: 0, bytes: 0, skipped, cancelled: true };
    }
    throw error;
  }
}
