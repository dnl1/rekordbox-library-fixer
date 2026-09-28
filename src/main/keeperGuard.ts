import * as fs from 'fs';
import { hostEnvironment, toHostPath } from './hostPath';

/**
 * Whether a library location is a regular file on this machine. Under WSL a
 * Windows library's `C:/…` is looked up at `/mnt/c/…`; everywhere else the
 * location is used as stored.
 */
export function isHostFile(location: string): boolean {
  if (!location) { return false; }
  try { return fs.statSync(toHostPath(location, hostEnvironment())).isFile(); } catch { return false; }
}

/**
 * Why a duplicate set must be left alone, or null when it can be merged.
 *
 * Merging folds every copy into the kept entry. If the kept entry's file is not
 * there — a drive unplugged, a file moved — while a copy being retired still has
 * its audio, the merge would leave the song pointing at nothing, and trashing
 * the copies would throw away the only file. When no copy has a file, nothing
 * can be lost and the entries may still be merged.
 */
export function keeperProblem(
  keeperLocation: string | undefined,
  removedLocations: Array<string | undefined>,
  isFile: (location: string) => boolean
): string | null {
  if (keeperLocation && isFile(keeperLocation)) { return null; }
  const survivor = removedLocations.find((loc): loc is string => !!loc && isFile(loc));
  if (!survivor) { return null; }
  return `the kept copy's file is missing (${keeperLocation || 'no location'}) but ${survivor} is there`;
}
