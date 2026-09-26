import * as fs from 'fs';
import * as os from 'os';

/**
 * Where a path stored in a library lives on this machine's disk.
 *
 * rekordbox runs on Windows or macOS and stores what it sees there —
 * `C:/Users/dj/Music/Track.flac`. Run this app under WSL on the same machine
 * and that file is at `/mnt/c/Users/dj/Music/Track.flac`: open the Windows
 * master.db from Linux and every track read as missing, because Linux has no
 * `C:` at all.
 *
 * The library keeps its own spelling. Only file access goes through here: a
 * path written back into rekordbox's database must stay `C:/…`, or rekordbox
 * would be handed a Linux path it cannot open.
 */

export interface HostEnvironment {
  platform: NodeJS.Platform;
  /** `os.release()`: WSL kernels say "microsoft" in it. */
  release: string;
  wslDistro?: string;
  /** WSL's automount root, `/mnt/` unless /etc/wsl.conf says otherwise. */
  mountRoot: string;
}

export function isWsl(env: Pick<HostEnvironment, 'platform' | 'release' | 'wslDistro'>): boolean {
  return env.platform === 'linux' && (!!env.wslDistro || /microsoft/i.test(env.release));
}

/** The `root` under `[automount]` in /etc/wsl.conf, normalised to end in a slash. */
export function wslMountRoot(wslConf: string | null): string {
  if (!wslConf) { return '/mnt/'; }
  let inAutomount = false;
  for (const raw of wslConf.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    const section = line.match(/^\[(.+)\]$/);
    if (section) { inAutomount = section[1].trim().toLowerCase() === 'automount'; continue; }
    const setting = inAutomount && line.match(/^root\s*=\s*"?([^"]+?)"?$/i);
    if (setting) { return setting[1].endsWith('/') ? setting[1] : `${setting[1]}/`; }
  }
  return '/mnt/';
}

/**
 * `C:/x`, `C:\x` — and `/C:/x`, which is what a `file://localhost/C:/x` XML
 * location decodes to on Linux — become `<mountRoot>c/x` under WSL. Anything
 * else, and everything on any other system, is returned as it is.
 */
export function toHostPath(libraryPath: string, env: HostEnvironment): string {
  if (!libraryPath || !isWsl(env)) { return libraryPath; }
  const drive = libraryPath.match(/^\/?([A-Za-z]):[\\/](.*)$/);
  if (!drive) { return libraryPath; }
  return `${env.mountRoot}${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`;
}

let cached: HostEnvironment | null = null;

/** This process's environment, read once. */
export function hostEnvironment(): HostEnvironment {
  if (!cached) {
    let wslConf: string | null = null;
    try { wslConf = fs.readFileSync('/etc/wsl.conf', 'utf8'); } catch { /* absent is the default */ }
    cached = {
      platform: process.platform,
      release: os.release(),
      wslDistro: process.env.WSL_DISTRO_NAME,
      mountRoot: wslMountRoot(wslConf),
    };
  }
  return cached;
}
