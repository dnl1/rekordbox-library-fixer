import { describe, it, expect, vi, afterEach } from 'vitest';
vi.unmock('fs');
vi.unmock('crypto');

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3-multiple-ciphers';
import {
  b85decode, readZipEntry, keyFromWheel, keyFromPyrekordboxPackage, PYREKORDBOX_WHEEL,
} from '../../src/main/dbKeyFromPackage';
import { keyOpensDatabase, unlockDatabase } from '../../src/main/rekordboxDbParser';

/**
 * A wheel laid out like pyrekordbox 0.4 with a made-up key in it, built with
 * Python's own zipfile, zlib and base64. The real key never enters the repo.
 */
const FAKE_WHEEL = fs.readFileSync(path.resolve(__dirname, '../fixtures/fake-pyrekordbox.whl'));
const FAKE_KEY = 'c0ffee'.repeat(10) + 'beef';
const FAKE_SHA = createHash('sha256').update(FAKE_WHEEL).digest('hex');

describe('b85decode', () => {
  it('matches Python base64.b85decode', () => {
    expect(b85decode('Xk~0{Zy<MXa%^M').toString()).toBe('hello world');
    expect([...b85decode('009C61O)~M2nh')]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('refuses what is not base85', () => {
    expect(() => b85decode('abc"')).toThrow(/not base85/);
  });
});

describe('readZipEntry', () => {
  it('reads deflated and stored entries, and says when one is absent', () => {
    expect(readZipEntry(FAKE_WHEEL, 'pyrekordbox/utils.py')!.toString()).toContain('BLOB_KEY = b"');
    expect(readZipEntry(FAKE_WHEEL, 'pyrekordbox/README.txt')!.toString()).toBe('stored entry');
    expect(readZipEntry(FAKE_WHEEL, 'nope.py')).toBeNull();
  });

  it('refuses what is not a zip', () => {
    expect(() => readZipEntry(Buffer.alloc(100), 'x')).toThrow(/not a zip/);
  });
});

describe('keyFromWheel', () => {
  it('undoes the obfuscation the way pyrekordbox does', () => {
    expect(keyFromWheel(FAKE_WHEEL)).toBe(FAKE_KEY);
  });
});

describe('keyFromPyrekordboxPackage', () => {
  it('reads the key out of a wheel that matches its hash', async () => {
    const out = await keyFromPyrekordboxPackage({ fetchWheel: async () => FAKE_WHEEL, expectedSha256: FAKE_SHA });
    expect(out).toEqual({ ok: true, key: FAKE_KEY });
  });

  it('will not use a wheel whose hash is not the pinned one', async () => {
    // A swapped download must not be able to hand the app a key.
    const out = await keyFromPyrekordboxPackage({ fetchWheel: async () => FAKE_WHEEL });
    expect(out).toEqual({ ok: false, detail: 'the pyrekordbox download did not match its published hash, so it was not used' });
  });

  it('says when it cannot download', async () => {
    const out = await keyFromPyrekordboxPackage({ fetchWheel: async () => { throw new Error('offline'); } });
    expect(out).toMatchObject({ ok: false, detail: expect.stringContaining('offline') });
  });

  it('refuses a key that does not open the database', async () => {
    const out = await keyFromPyrekordboxPackage({
      fetchWheel: async () => FAKE_WHEEL, expectedSha256: FAKE_SHA, opensDatabase: async () => false,
    });
    expect(out).toEqual({ ok: false, detail: 'the key pyrekordbox gives does not open this database' });
  });

  it('pins a wheel on PyPI', () => {
    expect(PYREKORDBOX_WHEEL.url).toMatch(/^https:\/\/files\.pythonhosted\.org\/.*pyrekordbox-0\.4\.4-py3-none-any\.whl$/);
    expect(PYREKORDBOX_WHEEL.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('keyOpensDatabase', () => {
  const files: string[] = [];
  afterEach(() => { for (const f of files.splice(0)) { fs.rmSync(f, { force: true }); } });

  it('knows the right key from a wrong one, on a real SQLCipher database', async () => {
    const file = path.join(os.tmpdir(), `kod-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    files.push(file);
    const db = new Database(file);
    unlockDatabase(db, FAKE_KEY);
    db.exec('CREATE TABLE djmdContent (ID TEXT); INSERT INTO djmdContent VALUES (\'1\');');
    db.close();

    expect(await keyOpensDatabase(file, FAKE_KEY)).toBe(true);
    expect(await keyOpensDatabase(file, 'ab'.repeat(32))).toBe(false);
  });
});
