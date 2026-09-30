import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import type { UpdateInstallMode } from './ipcContract';

/**
 * New versions, read from this fork's GitHub releases and installed from them.
 *
 * Not electron-updater: its macOS path goes through Squirrel, which refuses an
 * unsigned app — and this one is unsigned. The releases already carry what is
 * needed instead: GitHub publishes a SHA-256 for every asset, and a download
 * that does not hash to it is thrown away before anything runs it.
 */
export const UPDATE_REPO = { owner: 'dnl1', repo: 'rekordbox-library-fixer' } as const;

export const RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases?per_page=30`;

export interface GithubAsset {
  name: string;
  size: number;
  browser_download_url: string;
  /** `sha256:<hex>`. Missing on assets uploaded before GitHub started recording it. */
  digest?: string | null;
}

export interface GithubRelease {
  tag_name: string;
  name?: string | null;
  body?: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at?: string | null;
  assets: GithubAsset[];
}

interface Version {
  core: number[];
  pre: Array<string | number>;
}

function parseVersion(v: string): Version | null {
  const m = v.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!m) { return null; }
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

export const isPrerelease = (v: string): boolean => (parseVersion(v)?.pre.length ?? 0) > 0;

/**
 * Semver order, prereleases included: 0.7.0-beta.4 < 0.7.0-beta.10 < 0.7.0.
 * A version that does not parse sorts below every one that does, so a
 * mistyped tag is never offered as an update.
 */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) { return va ? 1 : vb ? -1 : 0; }
  for (let i = 0; i < 3; i++) {
    if (va.core[i] !== vb.core[i]) { return va.core[i] < vb.core[i] ? -1 : 1; }
  }
  if (!va.pre.length || !vb.pre.length) { return va.pre.length ? -1 : vb.pre.length ? 1 : 0; }
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i];
    const y = vb.pre[i];
    if (x === undefined) { return -1; }
    if (y === undefined) { return 1; }
    if (x === y) { continue; }
    if (typeof x === 'number' && typeof y === 'number') { return x < y ? -1 : 1; }
    if (typeof x === 'number') { return -1; }
    if (typeof y === 'number') { return 1; }
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The newest release above `current`, or null. A beta build follows betas; a
 * stable build is offered stable releases only, so nobody lands on a beta by
 * pressing "update".
 */
export function newestRelease(releases: GithubRelease[], current: string): GithubRelease | null {
  const followBetas = isPrerelease(current);
  const candidates = releases
    .filter((r) => !r.draft && (followBetas || !r.prerelease) && parseVersion(r.tag_name))
    .filter((r) => compareVersions(r.tag_name, current) > 0)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  return candidates[0] ?? null;
}

export interface InstallTarget {
  platform: NodeJS.Platform;
  arch: string;
  isPackaged: boolean;
  /** The running AppImage, when the app is one (`$APPIMAGE`). */
  appImagePath?: string;
  /** Whether the running .app can be replaced — not translocated, its folder writable. */
  macBundleReplaceable?: boolean;
}

/**
 * The asset this machine installs from, and how.
 *
 * - Windows: the NSIS installer, which covers x64 and ia32 in one file.
 * - macOS: the zip for this architecture, swapped in for the running .app; or
 *   the DMG, opened for the user, when the .app cannot be replaced in place.
 * - Linux: a new AppImage over the running one; otherwise the .deb, opened in
 *   the system's package installer.
 *
 * A development build installs nothing: it is not the thing being released.
 */
export function pickAsset(
  assets: GithubAsset[], target: InstallTarget
): { asset: GithubAsset; mode: UpdateInstallMode } | null {
  if (!target.isPackaged) { return null; }
  const usable = assets.filter((a) => !/\.(blockmap|yml)$/i.test(a.name));
  const find = (test: (name: string) => boolean) => usable.find((a) => test(a.name));
  const arm = target.arch === 'arm64';

  let found: { asset: GithubAsset | undefined; mode: UpdateInstallMode } | null = null;
  if (target.platform === 'win32') {
    found = { asset: find((n) => /setup.*\.exe$/i.test(n)), mode: 'installer' };
  } else if (target.platform === 'darwin') {
    const archOk = (n: string) => (arm ? /arm64/i.test(n) : !/arm64/i.test(n));
    found = target.macBundleReplaceable
      ? { asset: find((n) => /-mac\.zip$/i.test(n) && archOk(n)), mode: 'replace' }
      : { asset: find((n) => /\.dmg$/i.test(n) && archOk(n)), mode: 'package' };
  } else if (target.platform === 'linux') {
    found = target.appImagePath
      ? { asset: find((n) => /\.AppImage$/i.test(n)), mode: 'replace' }
      : target.arch === 'x64'
        ? { asset: find((n) => /_amd64\.deb$/i.test(n)), mode: 'package' }
        : null;
  }
  return found?.asset ? { asset: found.asset, mode: found.mode } : null;
}

/** The hex SHA-256 GitHub recorded for an asset, or null. */
export function expectedSha256(asset: GithubAsset): string | null {
  const m = asset.digest?.match(/^sha256:([0-9a-f]{64})$/i);
  return m ? m[1].toLowerCase() : null;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; json(): Promise<unknown>; body: unknown;
  headers: { get(name: string): string | null };
}>;

const HEADERS = { 'User-Agent': 'rekordbox-library-fixer', Accept: 'application/vnd.github+json' };

export async function fetchReleases(fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<GithubRelease[]> {
  const res = await fetchImpl(RELEASES_API, { headers: HEADERS });
  if (res.status === 403 || res.status === 429) {
    throw new Error('GitHub is limiting requests from this network right now — try again in a while.');
  }
  if (!res.ok) { throw new Error(`GitHub answered ${res.status}`); }
  const data = await res.json();
  if (!Array.isArray(data)) { throw new Error('GitHub sent something that is not a list of releases'); }
  return data as GithubRelease[];
}

/**
 * Download an asset into `dir` and check it against GitHub's SHA-256. It is
 * written under a `.part` name and renamed only once it hashes right, so
 * nothing that failed the check is ever left where it could be run.
 */
export async function downloadVerified(
  asset: GithubAsset,
  dir: string,
  onProgress: (received: number, total: number) => void,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
  const expected = expectedSha256(asset);
  if (!expected) {
    throw new Error('This release does not say what its files should hash to, so it cannot be checked. '
      + 'Download it from the release page instead.');
  }
  await fs.promises.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, path.basename(asset.name));
  const partPath = `${finalPath}.part`;

  const res = await fetchImpl(asset.browser_download_url, { headers: { 'User-Agent': HEADERS['User-Agent'] }, signal });
  if (!res.ok || !res.body) { throw new Error(`The download failed: GitHub answered ${res.status}`); }
  const total = Number(res.headers.get('content-length')) || asset.size;

  const hash = createHash('sha256');
  const out = fs.createWriteStream(partPath);
  let received = 0;
  try {
    const body = res.body instanceof Readable
      ? res.body
      : Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    for await (const chunk of body as AsyncIterable<Buffer>) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) { await new Promise<void>((resolve) => out.once('drain', () => resolve())); }
      onProgress(received, total);
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    const actual = hash.digest('hex');
    if (actual !== expected) {
      throw new Error('The download does not match the checksum GitHub published for it — it was not installed.');
    }
    await fs.promises.rename(partPath, finalPath);
    return finalPath;
  } catch (error) {
    out.destroy();
    await fs.promises.rm(partPath, { force: true });
    throw error;
  }
}

/** Single-quoted for /bin/sh. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, '\'\\\'\'')}'`;

/**
 * The script that swaps the .app once this process has exited: macOS will not
 * let a running bundle be replaced cleanly. The old bundle is moved aside
 * first and put back if the new one cannot be moved in, so a failure leaves
 * the app that was there rather than none.
 */
export function macSwapScript(pid: number, newApp: string, targetApp: string): string {
  const t = shellQuote(targetApp);
  const n = shellQuote(newApp);
  const old = shellQuote(`${targetApp}.previous`);
  return [
    '#!/bin/sh',
    `while kill -0 ${pid} 2>/dev/null; do sleep 0.5; done`,
    `rm -rf ${old}`,
    `if mv ${t} ${old}; then`,
    `  if mv ${n} ${t}; then rm -rf ${old}; else mv ${old} ${t}; fi`,
    'fi',
    `xattr -dr com.apple.quarantine ${t} 2>/dev/null`,
    `open ${t}`,
    '',
  ].join('\n');
}

/** `/Applications/X.app/Contents/MacOS/X` → `/Applications/X.app`. */
export const macBundlePath = (execPath: string): string => path.resolve(execPath, '..', '..', '..');
