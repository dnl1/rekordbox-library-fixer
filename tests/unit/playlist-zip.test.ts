import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.unmock('fs');
vi.unmock('crypto');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { crc32 } from 'zlib';
import { ZipWriter } from '../../src/main/zipWriter';
import { planPlaylistZip, writePlaylistZip, statSize } from '../../src/main/playlistZip';
import { readZipEntry } from '../../src/main/dbKeyFromPackage';

const has = (cmd: string) => {
  try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
};

/** Every entry as Python's zipfile reads it — the strictest reader to hand, and it checks CRCs. */
const pythonEntries = (zip: string): Array<[string, number]> => JSON.parse(execFileSync('python3', ['-c', `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps([[i.filename, i.file_size] for i in z.infolist()]))
`, zip]).toString());

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-test-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const file = (name: string, content: string | Buffer) => {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};

describe('ZipWriter', () => {
  it('writes stored entries that read back byte for byte', async () => {
    const a = file('a.mp3', 'first track');
    const b = file('b.aiff', Buffer.alloc(3 * 1024 * 1024, 7)); // several read chunks
    const out = path.join(dir, 'out.zip');
    const zip = await ZipWriter.create(out);
    await zip.addFile(a, 'a.mp3');
    await zip.addFile(b, 'Café — b.aiff');
    await zip.finish();

    const buf = fs.readFileSync(out);
    expect(readZipEntry(buf, 'a.mp3')?.toString()).toBe('first track');
    expect(readZipEntry(buf, 'Café — b.aiff')?.equals(fs.readFileSync(b))).toBe(true);
    // The CRC patched into the header is the file's.
    expect(buf.readUInt32LE(14)).toBe(crc32(fs.readFileSync(a)) >>> 0);
  });

  it.runIf(has('python3'))('is a valid zip to another reader, CRCs included', async () => {
    const out = path.join(dir, 'out.zip');
    const zip = await ZipWriter.create(out);
    await zip.addFile(file('x.wav', 'x'.repeat(5000)), 'x.wav');
    await zip.addFile(file('y.wav', ''), 'y.wav');
    await zip.finish();
    expect(pythonEntries(out)).toEqual([['x.wav', 5000], ['y.wav', 0]]);
  });

  it.runIf(has('python3'))('writes ZIP64 records another reader accepts', async () => {
    // What a playlist past 4 GiB gets; forced here, since a 4 GiB fixture is not.
    const out = path.join(dir, 'out.zip');
    const zip = await ZipWriter.create(out, { forceZip64: true });
    await zip.addFile(file('big.aiff', 'z'.repeat(1234)), 'big.aiff');
    await zip.addFile(file('two.aiff', 'q'), 'two.aiff');
    await zip.finish();
    expect(pythonEntries(out)).toEqual([['big.aiff', 1234], ['two.aiff', 1]]);
  });

  it.runIf(has('unzip'))('passes unzip -t', async () => {
    const out = path.join(dir, 'out.zip');
    const zip = await ZipWriter.create(out, { forceZip64: true });
    await zip.addFile(file('t.mp3', 'abc'), 't.mp3');
    await zip.finish();
    expect(execFileSync('unzip', ['-t', out]).toString()).toMatch(/No errors detected/);
  });
});

describe('planPlaylistZip', () => {
  const sizes: Record<string, number> = { '/m/a.mp3': 10, '/m/b.aiff': 20, '/other/a.mp3': 5, '/m/A.MP3': 1 };
  const deps = { sizeOf: (p: string) => sizes[p] ?? null, toHost: (p: string) => p };
  const t = (id: string, location: string) => ({ id, name: id, artist: '', location });

  it('keeps playlist order and adds up the sizes', () => {
    const plan = planPlaylistZip([t('1', '/m/b.aiff'), t('2', '/m/a.mp3')], false, deps);
    expect(plan.entries.map((e) => e.name)).toEqual(['b.aiff', 'a.mp3']);
    expect(plan.totalBytes).toBe(30);
  });

  it('tells two files of one name apart, ignoring case', () => {
    const plan = planPlaylistZip([t('1', '/m/a.mp3'), t('2', '/other/a.mp3'), t('3', '/m/A.MP3')], false, deps);
    expect(plan.entries.map((e) => e.name)).toEqual(['a.mp3', 'a (2).mp3', 'A (3).MP3']);
  });

  it('puts a file two entries share in once', () => {
    const plan = planPlaylistZip([t('1', '/m/a.mp3'), t('2', '/m/a.mp3')], false, deps);
    expect(plan.entries).toHaveLength(1);
    expect(plan.skipped).toEqual([]);
  });

  it('skips and reports what has no file', () => {
    const plan = planPlaylistZip([t('1', '/gone.mp3'), t('2', 'tidal:tracks:123'), t('3', '/m/a.mp3')], false, deps);
    expect(plan.entries.map((e) => e.name)).toEqual(['a.mp3']);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['file not found', 'a streaming track has no file']);
  });

  it('numbers files in playlist order when asked, counting only what goes in', () => {
    const plan = planPlaylistZip([t('1', '/gone.mp3'), t('2', '/m/b.aiff'), t('3', '/m/a.mp3')], true, deps);
    expect(plan.entries.map((e) => e.name)).toEqual(['01 b.aiff', '02 a.mp3']);
  });

  it('names a Windows path by its file, and keeps names Windows can unpack', () => {
    const plan = planPlaylistZip([t('1', 'C:\\Music\\Intro: Live?.mp3')], false, {
      sizeOf: () => 1, toHost: (p) => p,
    });
    expect(plan.entries[0].name).toBe('Intro_ Live_.mp3');
  });

  it('reads through the host path, as under WSL', () => {
    const seen: string[] = [];
    planPlaylistZip([t('1', 'C:/Music/a.mp3')], false, {
      sizeOf: (p) => { seen.push(p); return 1; },
      toHost: (p) => p.replace('C:/', '/mnt/c/'),
    });
    expect(seen).toEqual(['/mnt/c/Music/a.mp3']);
  });
});

describe('writePlaylistZip', () => {
  const plan = () => planPlaylistZip(
    [{ id: '1', name: '', artist: '', location: file('a.mp3', 'aaa') },
      { id: '2', name: '', artist: '', location: file('sub/b.mp3', 'bbbb') }],
    false,
    { sizeOf: statSize, toHost: (p) => p },
  );

  it('writes the zip under its name only once it is complete', async () => {
    const out = path.join(dir, 'set.zip');
    const progress: number[] = [];
    const summary = await writePlaylistZip(plan(), out, (p) => progress.push(p.current), () => false);
    expect(summary).toMatchObject({ filesAdded: 2, bytes: 7, cancelled: false });
    expect(fs.existsSync(`${out}.part`)).toBe(false);
    const buf = fs.readFileSync(out);
    expect(readZipEntry(buf, 'a.mp3')?.toString()).toBe('aaa');
    expect(readZipEntry(buf, 'b.mp3')?.toString()).toBe('bbbb');
    expect(progress.at(-1)).toBe(2);
  });

  it('leaves nothing behind when cancelled', async () => {
    const out = path.join(dir, 'set.zip');
    const summary = await writePlaylistZip(plan(), out, () => undefined, () => true);
    expect(summary.cancelled).toBe(true);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(`${out}.part`)).toBe(false);
  });

  it('leaves nothing behind when a file disappears mid-run', async () => {
    const p = plan();
    fs.rmSync(p.entries[1].source);
    const out = path.join(dir, 'set.zip');
    await expect(writePlaylistZip(p, out, () => undefined, () => false)).rejects.toThrow(/b\.mp3/);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(`${out}.part`)).toBe(false);
  });
});
