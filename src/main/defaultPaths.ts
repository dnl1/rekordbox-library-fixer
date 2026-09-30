import * as path from 'path';

/**
 * The folder Consolidate gathers a library into when none was chosen: one of
 * its own inside the user's Music folder, joined the way the platform writes
 * paths — `~/Music/Rekordbox Library` on macOS and Linux,
 * `C:\Users\<name>\Music\Rekordbox Library` on Windows.
 *
 * A folder of its own, never the Music folder itself: resolving duplicates
 * keeps the copy inside the consolidate destination over any other, and
 * nearly every track would be inside Music.
 */
export const CONSOLIDATE_FOLDER_NAME = 'Rekordbox Library';

export function defaultConsolidateDestination(musicDir: string, platform: NodeJS.Platform): string {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(musicDir, CONSOLIDATE_FOLDER_NAME);
}
