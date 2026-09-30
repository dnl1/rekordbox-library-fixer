import * as crypto from 'crypto';

/**
 * A Navidrome server, spoken to through the Subsonic API it implements
 * (https://www.subsonic.org/pages/api.jsp, with Navidrome's OpenSubsonic
 * additions such as `samplingRate` and `bitDepth`).
 *
 * Every request carries token authentication: the password never travels, a
 * fresh salt and md5(password + salt) do. The files are fetched through
 * `download`, which hands over the original file as it sits on the server —
 * `stream` would transcode.
 */

export interface NavidromeConnection {
  url: string;
  username: string;
  password: string;
}

export interface SubsonicSong {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  year?: number;
  track?: number;
  discNumber?: number;
  /** Seconds. */
  duration?: number;
  /** kbit/s. */
  bitRate?: number;
  /** Bytes of the original file. */
  size?: number;
  /** The original file's extension, without the dot. */
  suffix: string;
  /** Where the file sits in the server's library, relative to it. */
  path?: string;
  samplingRate?: number;
  bitDepth?: number;
}

export interface SubsonicPlaylist {
  id: string;
  name: string;
  songCount: number;
  /** Seconds. */
  duration: number;
  owner?: string;
}

export interface SubsonicServerInfo {
  apiVersion: string;
  type?: string;
  serverVersion?: string;
}

export const SUBSONIC_API_VERSION = '1.16.1';
export const SUBSONIC_CLIENT = 'rekordbox-library-fixer';

export class SubsonicError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'SubsonicError';
  }
}

/**
 * The server address as typed, with nothing after the host but a path prefix.
 * A scheme is required rather than guessed: guessing https fails on a LAN
 * server without TLS, and guessing http would send credentials in the clear
 * to a server that has TLS.
 */
export function normalizeServerUrl(input: string): string {
  const text = (input ?? '').trim();
  if (!/^https?:\/\//i.test(text)) {
    throw new SubsonicError('Type the address with http:// or https:// in front, as your browser shows it.');
  }
  let url: URL;
  try { url = new URL(text); } catch { throw new SubsonicError(`"${text}" is not a web address.`); }
  if (url.search || url.hash) { throw new SubsonicError('Type only the server address, without anything after a ? or #.'); }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/** The query every request carries. The salt is fresh each time unless a test pins it. */
export function authQuery(conn: NavidromeConnection, salt = crypto.randomBytes(8).toString('hex')): URLSearchParams {
  return new URLSearchParams({
    u: conn.username,
    t: crypto.createHash('md5').update(conn.password + salt).digest('hex'),
    s: salt,
    v: SUBSONIC_API_VERSION,
    c: SUBSONIC_CLIENT,
    f: 'json',
  });
}

const ERROR_MESSAGES: Record<number, string> = {
  10: 'The server says a required parameter is missing.',
  20: 'This app is too new for the server — update Navidrome.',
  30: 'The server is too old for this app.',
  40: 'Wrong username or password.',
  41: 'The server does not accept token sign-in for this user.',
  50: 'This user is not allowed to do that on the server.',
  70: 'Not found on the server.',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A song as the server sent it, narrowed: nothing is trusted to have the right type. */
export function toSong(raw: unknown): SubsonicSong | null {
  if (!raw || typeof raw !== 'object') { return null; }
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id || r.isDir === true) { return null; }
  return {
    id,
    title: str(r.title),
    artist: str(r.artist),
    album: str(r.album),
    genre: str(r.genre),
    year: num(r.year),
    track: num(r.track),
    discNumber: num(r.discNumber),
    duration: num(r.duration),
    bitRate: num(r.bitRate),
    size: num(r.size),
    suffix: str(r.suffix).toLowerCase(),
    path: str(r.path) || undefined,
    samplingRate: num(r.samplingRate),
    bitDepth: num(r.bitDepth),
  };
}

function toPlaylist(raw: unknown): SubsonicPlaylist | null {
  if (!raw || typeof raw !== 'object') { return null; }
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) { return null; }
  return {
    id,
    name: str(r.name),
    songCount: num(r.songCount) ?? 0,
    duration: num(r.duration) ?? 0,
    owner: str(r.owner) || undefined,
  };
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v ? [v] : []);

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export function createSubsonicClient(conn: NavidromeConnection, fetchImpl: FetchLike = fetch) {
  const base = normalizeServerUrl(conn.url);
  if (!conn.username) { throw new SubsonicError('The username is empty.'); }

  const call = async (endpoint: string, params: Record<string, string | number> = {}) => {
    const query = authQuery(conn);
    for (const [k, v] of Object.entries(params)) { query.set(k, String(v)); }
    let res: Response;
    try {
      res = await fetchImpl(`${base}/rest/${endpoint}?${query}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SubsonicError(`Could not reach ${base} — ${reason}`);
    }
    if (!res.ok) { throw new SubsonicError(`${base} answered HTTP ${res.status}. Is this the Navidrome address?`); }
    let body: unknown;
    try { body = await res.json(); } catch { throw new SubsonicError(`${base} did not answer like a Navidrome server.`); }
    const reply = (body as Record<string, unknown> | null)?.['subsonic-response'] as Record<string, unknown> | undefined;
    if (!reply) { throw new SubsonicError(`${base} did not answer like a Navidrome server.`); }
    if (reply.status !== 'ok') {
      const err = (reply.error ?? {}) as { code?: unknown; message?: unknown };
      const code = num(err.code);
      throw new SubsonicError((code !== undefined && ERROR_MESSAGES[code]) || str(err.message) || 'The server refused the request.', code);
    }
    return reply;
  };

  return {
    baseUrl: base,

    async ping(): Promise<SubsonicServerInfo> {
      const r = await call('ping.view');
      return {
        apiVersion: str(r.version), type: str(r.type) || undefined, serverVersion: str(r.serverVersion) || undefined,
      };
    },

    async playlists(): Promise<SubsonicPlaylist[]> {
      const r = await call('getPlaylists.view');
      const list = (r.playlists as Record<string, unknown> | undefined)?.playlist;
      return asList(list).map(toPlaylist).filter((p): p is SubsonicPlaylist => p !== null);
    },

    /** A playlist's name and songs, in its order. */
    async playlist(id: string): Promise<{ name: string; songs: SubsonicSong[] }> {
      const r = await call('getPlaylist.view', { id });
      const playlist = (r.playlist ?? {}) as Record<string, unknown>;
      return {
        name: str(playlist.name),
        songs: asList(playlist.entry).map(toSong).filter((s): s is SubsonicSong => s !== null),
      };
    },

    /** One song, read from the server rather than taken on trust from whoever asked. */
    async song(id: string): Promise<SubsonicSong> {
      const r = await call('getSong.view', { id });
      const song = toSong(r.song);
      if (!song) { throw new SubsonicError('Not found on the server.', 70); }
      return song;
    },

    async searchSongs(query: string, count = 100, offset = 0): Promise<SubsonicSong[]> {
      const r = await call('search3.view', { query, songCount: count, songOffset: offset, artistCount: 0, albumCount: 0 });
      const songs = (r.searchResult3 as Record<string, unknown> | undefined)?.song;
      return asList(songs).map(toSong).filter((s): s is SubsonicSong => s !== null);
    },

    /** The original file, untranscoded. Signed per call, so it must not be logged or shown. */
    downloadUrl(id: string): string {
      const query = authQuery(conn);
      query.set('id', id);
      return `${base}/rest/download.view?${query}`;
    },
  };
}

export type SubsonicClient = ReturnType<typeof createSubsonicClient>;
