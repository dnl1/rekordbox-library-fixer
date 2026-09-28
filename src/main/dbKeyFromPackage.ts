import { createHash } from 'crypto';
import { inflateRawSync, inflateSync } from 'zlib';

/**
 * Get the rekordbox database key from the pyrekordbox package itself, without
 * Python.
 *
 * pyrekordbox carries the key obfuscated in its source — `BLOB` in
 * db6/database.py, `BLOB_KEY` in utils.py — and prints it by undoing that:
 * base85, XOR, zlib. This does the same to a copy of the package fetched from
 * PyPI, so the key still comes from the open-source package, on the user's
 * machine, and never from this app. The wheel is pinned by hash: a swapped
 * download must not be able to hand the app a key of someone else's making.
 */

export const PYREKORDBOX_WHEEL = {
  url: 'https://files.pythonhosted.org/packages/b1/a8/28d28f02683bee40e3cfa32caed7c46e47daffb51482798fea9af0ab23cb/pyrekordbox-0.4.4-py3-none-any.whl',
  sha256: '2de933870126b9a0ef04bea372f1c5934efcfbb2501efb6b47d8ace0e17fb3d8',
} as const;

/** Python's `base64.b85decode` alphabet (RFC 1924), not Ascii85. */
const B85 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';

export function b85decode(text: string): Buffer {
  const values = [...text].map((ch) => {
    const v = B85.indexOf(ch);
    if (v < 0) { throw new Error(`not base85: ${JSON.stringify(ch)}`); }
    return v;
  });
  const padding = (5 - (values.length % 5)) % 5;
  for (let i = 0; i < padding; i++) { values.push(84); }
  const out = Buffer.alloc((values.length / 5) * 4);
  for (let i = 0; i < values.length; i += 5) {
    let n = 0;
    for (let j = 0; j < 5; j++) { n = n * 85 + values[i + j]; }
    if (n > 0xffffffff) { throw new Error('base85 overflow'); }
    out.writeUInt32BE(n, (i / 5) * 4);
  }
  return out.subarray(0, out.length - padding);
}

/** pyrekordbox's `deobfuscate`: base85, XOR with the key, zlib. */
export function deobfuscate(blob: string, xorKey: Buffer): string {
  const data = b85decode(blob);
  const xored = Buffer.from(data.map((b, i) => b ^ xorKey[i % xorKey.length]));
  return inflateSync(xored).toString('utf8');
}

/** One file out of a zip — a wheel is one — or null when it is not there. */
export function readZipEntry(zip: Buffer, name: string): Buffer | null {
  // The end-of-central-directory record sits in the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) { throw new Error('not a zip file'); }
  const entries = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);

  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) { throw new Error('damaged zip directory'); }
    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localHeader = zip.readUInt32LE(at + 42);
    const entryName = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) { continue; }

    if (zip.readUInt32LE(localHeader) !== 0x04034b50) { throw new Error('damaged zip entry'); }
    const start = localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28);
    const body = zip.subarray(start, start + compressedSize);
    if (method === 0) { return Buffer.from(body); }
    if (method === 8) { return inflateRawSync(body); }
    throw new Error(`unsupported zip compression ${method}`);
  }
  return null;
}

/** A `NAME = b"…"` constant from Python source. Base85 has no quote or backslash. */
function bytesConstant(source: string, name: string): string | null {
  return source.match(new RegExp(`^${name}\\s*=\\s*b"([^"\\\\]*)"`, 'm'))?.[1] ?? null;
}

/** The key, read out of a pyrekordbox wheel the way pyrekordbox reads it. */
export function keyFromWheel(wheel: Buffer): string {
  const utils = readZipEntry(wheel, 'pyrekordbox/utils.py');
  const database = readZipEntry(wheel, 'pyrekordbox/db6/database.py');
  if (!utils || !database) { throw new Error('this pyrekordbox does not keep the key where 0.4 does'); }
  const xorKey = bytesConstant(utils.toString('utf8'), 'BLOB_KEY');
  const blob = bytesConstant(database.toString('utf8'), 'BLOB');
  if (!xorKey || !blob) { throw new Error('this pyrekordbox does not keep the key where 0.4 does'); }
  const key = deobfuscate(blob, Buffer.from(xorKey, 'latin1')).trim();
  if (!/^[0-9a-f]{64}$/i.test(key)) { throw new Error('pyrekordbox yielded something that is not a key'); }
  return key.toLowerCase();
}

export type PackageKeyRecovery = { ok: true; key: string } | { ok: false; detail: string };

/**
 * Fetch the pinned wheel, check it, read the key, and — when given a way to —
 * check the key opens the database before anyone stores it.
 */
export async function keyFromPyrekordboxPackage(options: {
  fetchWheel?: () => Promise<Buffer>;
  opensDatabase?: (key: string) => Promise<boolean>;
  /** For tests: the hash a fake wheel must match instead of the pinned one. */
  expectedSha256?: string;
} = {}): Promise<PackageKeyRecovery> {
  const fetchWheel = options.fetchWheel ?? (async () => {
    const res = await fetch(PYREKORDBOX_WHEEL.url);
    if (!res.ok) { throw new Error(`PyPI answered ${res.status}`); }
    return Buffer.from(await res.arrayBuffer());
  });

  let wheel: Buffer;
  try {
    wheel = await fetchWheel();
  } catch (error) {
    return { ok: false, detail: `pyrekordbox could not be downloaded (${error instanceof Error ? error.message : error})` };
  }
  const sha256 = createHash('sha256').update(wheel).digest('hex');
  if (sha256 !== (options.expectedSha256 ?? PYREKORDBOX_WHEEL.sha256)) {
    return { ok: false, detail: 'the pyrekordbox download did not match its published hash, so it was not used' };
  }

  let key: string;
  try {
    key = keyFromWheel(wheel);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  if (options.opensDatabase && !(await options.opensDatabase(key))) {
    return { ok: false, detail: 'the key pyrekordbox gives does not open this database' };
  }
  return { ok: true, key };
}
