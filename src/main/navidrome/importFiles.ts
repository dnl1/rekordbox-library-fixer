import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { FetchLike, SubsonicSong } from './subsonic';

export { REKORDBOX_FILE_TYPES, fileTypeFor } from './fileTypes';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_SEGMENT = 120;

/**
 * One folder or file name, safe on every platform: no separators or characters
 * Windows refuses, no trailing dot or space, never `.` or `..`.
 */
export function safeSegment(name: string, keepExtension = false): string {
  const printable = Array.from(name ?? '', (ch) => (ch.charCodeAt(0) < 0x20 ? '_' : ch)).join('');
  let text = printable.replace(/[<>:"/\\|?*]/g, '_').trim().replace(/[. ]+$/, '');
  if (!text || text === '.' || text === '..') { text = '_'; }
  const ext = keepExtension ? path.extname(text) : '';
  let stem = ext ? text.slice(0, -ext.length) : text;
  if (WINDOWS_RESERVED.test(stem)) { stem = `_${stem}`; }
  if (stem.length + ext.length > MAX_SEGMENT) { stem = stem.slice(0, MAX_SEGMENT - ext.length).trim(); }
  return stem + ext;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Where a song goes under `root`. The server's own folder layout is kept when
 * it says where the file sits — Artist/Album/01 - Title.flac, usually — and is
 * built from the tags otherwise. The name always ends in the file's real
 * extension, and the result never leaves `root`, whatever the server sent.
 */
export function plannedPath(root: string, song: SubsonicSong): string {
  const ext = song.suffix ? `.${song.suffix}` : '';
  const fromServer = (song.path ?? '').split(/[\\/]+/).filter(Boolean);
  let segments: string[];
  if (fromServer.length > 0) {
    const file = fromServer.pop() as string;
    const name = path.extname(file).toLowerCase() === ext.toLowerCase() ? file : `${file}${ext}`;
    segments = [...fromServer.map((s) => safeSegment(s)), safeSegment(name, true)];
  } else {
    const title = song.title || song.id;
    const file = `${song.track ? `${pad2(song.track)} - ` : ''}${title}${ext}`;
    segments = [safeSegment(song.artist || 'Unknown Artist'), safeSegment(song.album || 'Unknown Album'), safeSegment(file, true)];
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  if (!target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`The server gave a path outside the destination: ${song.path ?? song.title}`);
  }
  return target;
}

export interface DownloadOptions {
  fetchImpl?: FetchLike;
  /** The size the server reported; a file of any other size is not kept. */
  expectedSize?: number;
  signal?: AbortSignal;
  onBytes?: (received: number) => void;
}

/**
 * Fetch a file to `dest` through a `.part` beside it, so an interrupted or
 * short download never takes the real name. The folders are created.
 */
export async function downloadToFile(url: string, dest: string, options: DownloadOptions = {}): Promise<number> {
  const fetchImpl = options.fetchImpl ?? fetch;
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  try {
    const res = await fetchImpl(url, { signal: options.signal });
    if (!res.ok || !res.body) { throw new Error(`the server answered HTTP ${res.status}`); }
    let received = 0;
    const counted = Readable.fromWeb(res.body as import('stream/web').ReadableStream).on('data', (chunk: Buffer) => {
      received += chunk.length;
      options.onBytes?.(received);
    });
    await pipeline(counted, fs.createWriteStream(part), { signal: options.signal });
    if (options.expectedSize && options.expectedSize > 0 && received !== options.expectedSize) {
      throw new Error(`got ${received} bytes of ${options.expectedSize}`);
    }
    await fs.promises.rename(part, dest);
    return received;
  } catch (error) {
    await fs.promises.rm(part, { force: true });
    throw error;
  }
}
