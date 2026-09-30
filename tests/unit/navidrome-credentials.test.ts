import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.unmock('fs');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { connectionPath, forgetConnection, loadConnection, saveConnection, type Crypter } from '../../src/main/navidrome/credentials';

/** Stands in for the keychain: reversible, and nothing like the plain text. */
const keychain: Crypter = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain.split('').reverse().join(''), 'utf8').map((b) => b ^ 0x5a) as Buffer,
  decryptString: (enc) => Buffer.from(enc.map((b) => b ^ 0x5a)).toString('utf8').split('').reverse().join(''),
};

let dir: string;
let file: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-')); file = connectionPath(dir); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const conn = { url: 'https://music.example.com', username: 'dj', password: 'sesame' };

describe('Navidrome connection storage', () => {
  it('reads back what it saved', () => {
    saveConnection(file, conn, keychain);
    expect(loadConnection(file, keychain)).toEqual(conn);
  });

  it('never writes the password as it was typed', () => {
    saveConnection(file, conn, keychain);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('sesame');
  });

  it('refuses to save without a keychain rather than write the password in the clear', () => {
    expect(() => saveConnection(file, conn, { ...keychain, isEncryptionAvailable: () => false })).toThrow(/no secure storage/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('reads a file it cannot decrypt, or a damaged one, as no connection', () => {
    saveConnection(file, conn, keychain);
    expect(loadConnection(file, { ...keychain, decryptString: () => { throw new Error('other account'); } })).toBeNull();
    fs.writeFileSync(file, '{ not json');
    expect(loadConnection(file, keychain)).toBeNull();
    expect(loadConnection(path.join(dir, 'missing.json'), keychain)).toBeNull();
  });

  it('forgets', () => {
    saveConnection(file, conn, keychain);
    forgetConnection(file);
    expect(loadConnection(file, keychain)).toBeNull();
    expect(() => forgetConnection(file)).not.toThrow();
  });
});
