import * as fs from 'fs';
import * as path from 'path';
import type { NavidromeConnection } from './subsonic';

/**
 * The Navidrome connection, kept in the app's own folder. The address and the
 * username are plain; the password is encrypted with the operating system's
 * keychain (Electron's `safeStorage`), so the file is useless copied to
 * another account or machine. Without a keychain the password is refused
 * rather than written in the clear.
 *
 * The renderer never receives the password back — only whether one is saved.
 */

export interface Crypter {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface StoredFile {
  url: string;
  username: string;
  /** base64 of the keychain-encrypted password. */
  password: string;
}

export const CONNECTION_FILE = 'navidrome-connection.json';

export function connectionPath(userDataDir: string): string {
  return path.join(userDataDir, CONNECTION_FILE);
}

export function saveConnection(file: string, conn: NavidromeConnection, crypter: Crypter): void {
  if (!crypter.isEncryptionAvailable()) {
    throw new Error('This computer has no secure storage for the password, so it is not saved.');
  }
  const stored: StoredFile = {
    url: conn.url,
    username: conn.username,
    password: crypter.encryptString(conn.password).toString('base64'),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Owner-only: the password is encrypted, but the address and username are not.
  fs.writeFileSync(file, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** The saved connection, or null when there is none or it cannot be read back. */
export function loadConnection(file: string, crypter: Crypter): NavidromeConnection | null {
  let stored: Partial<StoredFile>;
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (typeof stored.url !== 'string' || typeof stored.username !== 'string' || typeof stored.password !== 'string') {
    return null;
  }
  try {
    return { url: stored.url, username: stored.username, password: crypter.decryptString(Buffer.from(stored.password, 'base64')) };
  } catch {
    // Encrypted by another account or machine: as good as absent.
    return null;
  }
}

export function forgetConnection(file: string): void {
  fs.rmSync(file, { force: true });
}
