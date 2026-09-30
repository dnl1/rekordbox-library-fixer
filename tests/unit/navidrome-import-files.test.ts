import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.unmock('fs');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadToFile, fileTypeFor, plannedPath, safeSegment } from '../../src/main/navidrome/importFiles';
import type { SubsonicSong } from '../../src/main/navidrome/subsonic';

const song = (over: Partial<SubsonicSong> = {}): SubsonicSong => ({
  id: 's1', title: 'Explorers', artist: 'Avalon', album: 'Psy', genre: '', suffix: 'flac', ...over,
});

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('fileTypeFor', () => {
  it('knows what rekordbox plays, and nothing else', () => {
    expect([fileTypeFor('mp3'), fileTypeFor('M4A'), fileTypeFor('flac'), fileTypeFor('wav'), fileTypeFor('aiff'), fileTypeFor('aif')])
      .toEqual([1, 4, 5, 11, 12, 12]);
    expect(fileTypeFor('ogg')).toBeUndefined();
    expect(fileTypeFor('opus')).toBeUndefined();
  });
});

describe('safeSegment', () => {
  it('makes a name every platform accepts', () => {
    expect(safeSegment('AC/DC: Live?')).toBe('AC_DC_ Live_');
    expect(safeSegment('Trailing dots...')).toBe('Trailing dots');
    expect(safeSegment('..')).toBe('_');
    expect(safeSegment('CON')).toBe('_CON');
    expect(safeSegment('nul.mp3', true)).toBe('_nul.mp3');
  });

  it('keeps the extension when it shortens a long name', () => {
    const long = safeSegment(`${'x'.repeat(300)}.flac`, true);
    expect(long.endsWith('.flac')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(120);
  });
});

describe('plannedPath', () => {
  it('keeps the folders the server keeps the file in', () => {
    expect(plannedPath(root, song({ path: 'Avalon/Psy/01 - Explorers.flac' }))).toBe(path.join(root, 'Avalon', 'Psy', '01 - Explorers.flac'));
  });

  it('builds Artist/Album/NN - Title from the tags when the server gives no path', () => {
    expect(plannedPath(root, song({ track: 3 }))).toBe(path.join(root, 'Avalon', 'Psy', '03 - Explorers.flac'));
    expect(plannedPath(root, song({ artist: '', album: '', title: '' }))).toBe(path.join(root, 'Unknown Artist', 'Unknown Album', 's1.flac'));
  });

  it('ends the name in the real extension', () => {
    expect(plannedPath(root, song({ path: 'Avalon/Explorers', suffix: 'mp3' }))).toBe(path.join(root, 'Avalon', 'Explorers.mp3'));
  });

  it('never leaves the destination, whatever the server sends', () => {
    const escaped = plannedPath(root, song({ path: '../../../etc/passwd.flac' }));
    expect(escaped.startsWith(root + path.sep)).toBe(true);
    expect(escaped).toBe(path.join(root, '_', '_', '_', 'etc', 'passwd.flac'));
  });
});

const streamOf = (bytes: number) => new Response(new Uint8Array(bytes).fill(7), { status: 200 });

describe('downloadToFile', () => {
  it('writes the file, creating its folders', async () => {
    const dest = path.join(root, 'a', 'b', 'song.flac');
    const seen: number[] = [];
    const size = await downloadToFile('https://x/y', dest, { fetchImpl: async () => streamOf(1000), expectedSize: 1000, onBytes: (n) => seen.push(n) });
    expect(size).toBe(1000);
    expect(fs.statSync(dest).size).toBe(1000);
    expect(seen[seen.length - 1]).toBe(1000);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it('keeps nothing when the file arrives short', async () => {
    const dest = path.join(root, 'short.flac');
    await expect(downloadToFile('https://x/y', dest, { fetchImpl: async () => streamOf(10), expectedSize: 1000 })).rejects.toThrow(/10 bytes of 1000/);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it('keeps nothing when the server refuses', async () => {
    const dest = path.join(root, 'gone.flac');
    await expect(downloadToFile('https://x/y', dest, { fetchImpl: async () => new Response('no', { status: 404 }) })).rejects.toThrow(/HTTP 404/);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
