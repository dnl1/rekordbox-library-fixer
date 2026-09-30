import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.unmock('fs');
vi.unmock('crypto');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import {
  compareVersions, newestRelease, pickAsset, expectedSha256, downloadVerified, fetchReleases,
  macSwapScript, macBundlePath, shellQuote, RELEASES_API, type GithubAsset, type GithubRelease,
} from '../../src/main/appUpdate';

const release = (tag: string, extra: Partial<GithubRelease> = {}): GithubRelease => ({
  tag_name: tag, html_url: `https://github.com/x/y/releases/tag/${tag}`,
  draft: false, prerelease: tag.includes('-'), assets: [], ...extra,
});

describe('compareVersions', () => {
  it('orders prereleases numerically and below the release', () => {
    const sorted = ['0.7.0', '0.7.0-beta.10', 'v0.7.0-beta.4', '0.6.9', '0.7.0-alpha', '0.7.1-beta.1']
      .sort(compareVersions);
    expect(sorted).toEqual(['0.6.9', '0.7.0-alpha', 'v0.7.0-beta.4', '0.7.0-beta.10', '0.7.0', '0.7.1-beta.1']);
  });

  it('never ranks a tag that does not parse above one that does', () => {
    expect(compareVersions('nightly', '0.0.1')).toBeLessThan(0);
  });
});

describe('newestRelease', () => {
  const releases = [
    release('v0.7.0-beta.4'), release('v0.7.0-beta.5'), release('v0.7.0-beta.6', { draft: true }),
    release('v0.6.0'), release('v0.6.1'),
  ];

  it('offers a beta build the newest beta, never a draft', () => {
    expect(newestRelease(releases, '0.7.0-beta.4')?.tag_name).toBe('v0.7.0-beta.5');
  });

  it('offers a stable build stable releases only', () => {
    expect(newestRelease(releases, '0.6.0')?.tag_name).toBe('v0.6.1');
  });

  it('offers nothing when this is the newest', () => {
    expect(newestRelease(releases, '0.7.0-beta.5')).toBeNull();
  });
});

describe('pickAsset', () => {
  // The names the release workflow actually uploads.
  const names = [
    'latest.yml', 'Rekordbox.Library.Fixer.Setup.0.7.0-beta.4.exe', 'Rekordbox.Library.Fixer.Setup.0.7.0-beta.4.exe.blockmap',
    'Rekordbox.Library.Fixer-0.7.0-beta.4-arm64-mac.zip', 'Rekordbox.Library.Fixer-0.7.0-beta.4-mac.zip',
    'Rekordbox.Library.Fixer-0.7.0-beta.4-arm64.dmg', 'Rekordbox.Library.Fixer-0.7.0-beta.4.dmg',
    'Rekordbox.Library.Fixer-0.7.0-beta.4.AppImage', 'rekordbox-library-manager_0.7.0-beta.4_amd64.deb',
    'Rekordbox.Library.Fixer-0.7.0-beta.4-win.zip',
  ];
  const assets: GithubAsset[] = names.map((name) => ({ name, size: 1, browser_download_url: `https://x/${name}` }));
  const pick = (t: Parameters<typeof pickAsset>[1]) => {
    const p = pickAsset(assets, t);
    return p && [p.asset.name, p.mode];
  };

  it('runs the installer on Windows', () => {
    expect(pick({ platform: 'win32', arch: 'x64', isPackaged: true }))
      .toEqual(['Rekordbox.Library.Fixer.Setup.0.7.0-beta.4.exe', 'installer']);
  });

  it('swaps in the zip for this Mac’s architecture', () => {
    expect(pick({ platform: 'darwin', arch: 'arm64', isPackaged: true, macBundleReplaceable: true }))
      .toEqual(['Rekordbox.Library.Fixer-0.7.0-beta.4-arm64-mac.zip', 'replace']);
    expect(pick({ platform: 'darwin', arch: 'x64', isPackaged: true, macBundleReplaceable: true }))
      .toEqual(['Rekordbox.Library.Fixer-0.7.0-beta.4-mac.zip', 'replace']);
  });

  it('opens the DMG when the running app cannot be replaced', () => {
    expect(pick({ platform: 'darwin', arch: 'x64', isPackaged: true, macBundleReplaceable: false }))
      .toEqual(['Rekordbox.Library.Fixer-0.7.0-beta.4.dmg', 'package']);
  });

  it('replaces an AppImage, and opens the .deb otherwise', () => {
    expect(pick({ platform: 'linux', arch: 'x64', isPackaged: true, appImagePath: '/home/u/App.AppImage' }))
      .toEqual(['Rekordbox.Library.Fixer-0.7.0-beta.4.AppImage', 'replace']);
    expect(pick({ platform: 'linux', arch: 'x64', isPackaged: true }))
      .toEqual(['rekordbox-library-manager_0.7.0-beta.4_amd64.deb', 'package']);
  });

  it('installs nothing into a development build', () => {
    expect(pick({ platform: 'win32', arch: 'x64', isPackaged: false })).toBeNull();
  });
});

describe('fetchReleases', () => {
  it('reads this fork’s releases', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200, json: async () => [release('v1.0.0')], body: null, headers: { get: () => null },
    }));
    expect(await fetchReleases(fetchImpl)).toHaveLength(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(RELEASES_API);
    expect(RELEASES_API).toContain('/repos/dnl1/rekordbox-library-fixer/');
  });

  it('says so when GitHub limits the rate', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}), body: null, headers: { get: () => null } });
    await expect(fetchReleases(fetchImpl)).rejects.toThrow(/limiting/);
  });
});

describe('downloadVerified', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-test-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const content = Buffer.from('the new version');
  const sha = createHash('sha256').update(content).digest('hex');
  const serve = async () => ({
    ok: true, status: 200, json: async () => ({}), body: Readable.from([content.subarray(0, 5), content.subarray(5)]),
    headers: { get: (h: string) => (h === 'content-length' ? String(content.length) : null) },
  });
  const asset = (digest?: string): GithubAsset => ({
    name: 'Setup.exe', size: content.length, browser_download_url: 'https://x/Setup.exe', digest,
  });

  it('keeps a download that hashes to GitHub’s digest', async () => {
    const seen: number[] = [];
    const file = await downloadVerified(asset(`sha256:${sha}`), dir, (r) => seen.push(r), undefined, serve);
    expect(fs.readFileSync(file).equals(content)).toBe(true);
    expect(seen.at(-1)).toBe(content.length);
  });

  it('throws away one that does not, leaving nothing to run', async () => {
    await expect(downloadVerified(asset(`sha256:${'0'.repeat(64)}`), dir, () => undefined, undefined, serve))
      .rejects.toThrow(/checksum/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses an asset with no digest to check against', async () => {
    expect(expectedSha256(asset())).toBeNull();
    await expect(downloadVerified(asset(), dir, () => undefined, undefined, serve)).rejects.toThrow(/cannot be checked/);
  });
});

describe('the macOS swap', () => {
  it('finds the bundle from the executable', () => {
    expect(macBundlePath('/Applications/Rekordbox Library Fixer.app/Contents/MacOS/Rekordbox Library Fixer'))
      .toBe('/Applications/Rekordbox Library Fixer.app');
  });

  it('waits for the app to exit, and puts the old one back if the new one cannot move in', () => {
    const script = macSwapScript(42, '/tmp/u/New.app', "/Applications/Rekordbox's.app");
    expect(script).toContain('while kill -0 42');
    expect(script).toContain(`mv ${shellQuote("/Applications/Rekordbox's.app.previous")} ${shellQuote("/Applications/Rekordbox's.app")}`);
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});
