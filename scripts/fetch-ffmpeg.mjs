#!/usr/bin/env node
/**
 * Fetch the ffmpeg binary the FLAC conversion runs, for the platform and
 * architectures being built, into vendor/ffmpeg/<platform>-<arch>/.
 *
 * The binaries are the ffmpeg-static release builds. Each download is checked
 * against a pinned SHA-256 before it is unpacked: this is an executable the
 * app runs on the DJ's music, and a swapped asset must fail the build rather
 * than ship. The GPL licence text travels with the binary, as its licence
 * requires.
 *
 *   node scripts/fetch-ffmpeg.mjs                        # this machine
 *   node scripts/fetch-ffmpeg.mjs --platform darwin --arch x64,arm64
 *
 * A target already fetched is left alone, so this is cheap to run before
 * every dev start and every build.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const RELEASE = 'b6.1.1';
const BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}`;

/** SHA-256 of each gzipped binary and its licence, as published in the release. */
const PINNED = {
  'darwin-x64': {
    binary: '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
    license: '2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af',
  },
  'darwin-arm64': {
    binary: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
    license: 'cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2',
  },
  'win32-x64': {
    binary: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
    license: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
  },
  'linux-x64': {
    binary: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
    license: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
  },
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const platform = arg('platform') ?? process.platform;
const arches = (arg('arch') ?? process.arch).split(',').map((a) => a.trim()).filter(Boolean);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url, expected) {
  const res = await fetch(url);
  if (!res.ok) { throw new Error(`${url}: HTTP ${res.status}`); }
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== expected) {
    throw new Error(`${url}: checksum mismatch — expected ${expected}, got ${actual}. Refusing to use it.`);
  }
  return buf;
}

let failed = false;
for (const arch of arches) {
  const target = `${platform}-${arch}`;
  const pinned = PINNED[target];
  const dir = join(root, 'vendor', 'ffmpeg', target);
  if (!pinned) {
    // Not fatal: the app still builds, and the conversion tool says it is not
    // available on this build instead of offering a button that cannot work.
    // The folder is made anyway, empty, so electron-builder's extraResources
    // has a source to copy for this architecture rather than one that is missing.
    mkdirSync(dir, { recursive: true });
    console.warn(`[fetch-ffmpeg] no ffmpeg build for ${target}; FLAC conversion will be unavailable there.`);
    continue;
  }

  const exe = join(dir, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (existsSync(exe)) {
    console.log(`[fetch-ffmpeg] ${target}: already present`);
    continue;
  }

  try {
    console.log(`[fetch-ffmpeg] ${target}: downloading ffmpeg ${RELEASE}…`);
    const gz = await download(`${BASE}/ffmpeg-${target}.gz`, pinned.binary);
    const license = await download(`${BASE}/${target}.LICENSE`, pinned.license);

    mkdirSync(dir, { recursive: true });
    // Written aside and renamed, so an interrupted run never leaves a
    // truncated binary that the "already present" check would then trust.
    writeFileSync(`${exe}.part`, gunzipSync(gz));
    chmodSync(`${exe}.part`, 0o755);
    renameSync(`${exe}.part`, exe);
    writeFileSync(join(dir, 'LICENSE'), license);
    console.log(`[fetch-ffmpeg] ${target}: ok`);
  } catch (error) {
    failed = true;
    console.error(`[fetch-ffmpeg] ${target}: ${error instanceof Error ? error.message : error}`);
  }
}

if (failed) { process.exit(1); }
