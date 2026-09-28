import * as fs from 'fs';
import * as path from 'path';

export interface FfmpegLocation {
  isPackaged: boolean;
  /** `process.resourcesPath` — where electron-builder puts `extraResources`. */
  resourcesPath: string;
  /** `app.getAppPath()` — the repository root in development. */
  appPath: string;
  platform: NodeJS.Platform;
  arch: string;
  exists?: (p: string) => boolean;
}

/**
 * Where the bundled ffmpeg is, or null when this build has none.
 *
 * A packaged app carries it under `resources/ffmpeg/`, copied there per
 * platform and architecture by `scripts/fetch-ffmpeg.mjs` and electron-builder.
 * In development it is read from `vendor/ffmpeg/` directly. There is no
 * fallback to an ffmpeg on the PATH: the conversion depends on how this
 * particular build writes AIFF and WAV, and a different one found by chance
 * would make the result depend on the machine.
 */
export function resolveFfmpegPath(loc: FfmpegLocation): string | null {
  const exists = loc.exists ?? fs.existsSync;
  const exe = loc.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidate = loc.isPackaged
    ? path.join(loc.resourcesPath, 'ffmpeg', exe)
    : path.join(loc.appPath, 'vendor', 'ffmpeg', `${loc.platform}-${loc.arch}`, exe);
  return exists(candidate) ? candidate : null;
}
