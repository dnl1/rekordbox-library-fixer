import * as fs from 'fs';
import * as path from 'path';
import type { SubsonicClient, SubsonicSong } from './subsonic';
import { downloadToFile, fileTypeFor, plannedPath } from './importFiles';
import type { DbImportSummary, ImportPlaylist, ImportTrack } from '../rekordboxDbImport';
import { runPool } from '../workerPool';
import type {
  NavidromeImportProgress, NavidromeImportRequest, NavidromeImportSummary,
} from '../ipcContract';

/**
 * A Navidrome import from start to end: what to fetch, fetching it, and
 * writing it into rekordbox's database. Every dependency is handed in, so the
 * whole run is tested without a server, a network or an encrypted database.
 *
 * Nothing is written to the database until every download has finished, and
 * not at all if the run is cancelled: the files already fetched stay on disk
 * and are used as they are by the next run.
 */
export interface ImportDeps {
  client: SubsonicClient;
  download: typeof downloadToFile;
  writeDb: (tracks: ImportTrack[], playlists: ImportPlaylist[]) => DbImportSummary;
  isRekordboxRunning: () => boolean;
  onProgress: (progress: NavidromeImportProgress) => void;
  cancelToken: { cancelled: boolean; controller?: AbortController };
  /** Files fetched at once. */
  workers?: number;
}

const REKORDBOX_OPEN = 'Close rekordbox first — the tracks are written into its database.';

const describe = (song: SubsonicSong) => [song.artist, song.title].filter(Boolean).join(' — ') || song.id;

export async function runNavidromeImport(
  request: NavidromeImportRequest,
  deps: ImportDeps,
): Promise<NavidromeImportSummary> {
  const { operationId } = request;
  if (!path.isAbsolute(request.destination ?? '')) { throw new Error('Choose the folder the tracks are downloaded to.'); }
  if (deps.isRekordboxRunning()) { throw new Error(REKORDBOX_OPEN); }

  const summary: NavidromeImportSummary = {
    downloaded: 0, reused: 0, skipped: [], failed: [], tracksAdded: 0, tracksAlreadyThere: 0,
    playlists: [], playlistFileUpdated: true, cancelled: false,
  };

  // What to fetch: each playlist's songs as the server lists them, and each
  // picked song read back from the server.
  deps.onProgress({ operationId, phase: 'listing', current: 0, total: 0, currentFile: '' });
  const wanted: Array<{ name: string; songs: SubsonicSong[] }> = [];
  for (const id of request.playlistIds ?? []) {
    wanted.push(await deps.client.playlist(id));
  }
  const picked: SubsonicSong[] = [];
  for (const id of request.songIds ?? []) {
    picked.push(await deps.client.song(id));
  }

  const songs = new Map<string, SubsonicSong>();
  for (const song of [...wanted.flatMap((p) => p.songs), ...picked]) {
    if (!songs.has(song.id)) { songs.set(song.id, song); }
  }

  const plan: Array<{ song: SubsonicSong; target: string; fileType: number }> = [];
  for (const song of songs.values()) {
    const fileType = fileTypeFor(song.suffix);
    if (fileType === undefined) {
      summary.skipped.push({ title: describe(song), reason: `rekordbox cannot play .${song.suffix || '?'} files` });
      continue;
    }
    try {
      plan.push({ song, target: plannedPath(request.destination, song), fileType });
    } catch (error) {
      summary.skipped.push({ title: describe(song), reason: error instanceof Error ? error.message : String(error) });
    }
  }

  // Fetch, a few at a time. A file already there at the size the server
  // reports is the same file, from an earlier run: it is used, not fetched again.
  let done = 0;
  const ready = new Map<string, number>();
  const report = (currentFile: string) => deps.onProgress({ operationId, phase: 'downloading', current: done, total: plan.length, currentFile });
  report('');
  await runPool(plan, deps.workers ?? 3, async ({ song, target }) => {
    if (deps.cancelToken.cancelled) { return; }
    try {
      const existing = fs.existsSync(target) ? fs.statSync(target).size : -1;
      if (existing >= 0 && (!song.size || existing === song.size)) {
        ready.set(song.id, existing);
        summary.reused++;
      } else {
        report(describe(song));
        const size = await deps.download(deps.client.downloadUrl(song.id), target, {
          expectedSize: song.size, signal: deps.cancelToken.controller?.signal,
        });
        ready.set(song.id, size);
        summary.downloaded++;
      }
    } catch (error) {
      if (!deps.cancelToken.cancelled) {
        summary.failed.push({ title: describe(song), error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      done++;
      report('');
    }
  }, deps.cancelToken);

  if (deps.cancelToken.cancelled) {
    summary.cancelled = true;
    return summary;
  }

  const tracks: ImportTrack[] = plan
    .filter(({ song }) => ready.has(song.id))
    .map(({ song, target, fileType }) => ({
      location: target,
      title: song.title,
      artist: song.artist || undefined,
      album: song.album || undefined,
      genre: song.genre || undefined,
      year: song.year,
      trackNo: song.track,
      discNo: song.discNumber,
      length: song.duration,
      bitRate: song.bitRate,
      sampleRate: song.samplingRate,
      bitDepth: song.bitDepth,
      fileSize: ready.get(song.id) as number,
      fileType,
    }));
  const location = new Map(plan.map(({ song, target }) => [song.id, target]));
  const playlists: ImportPlaylist[] = wanted
    .map((p) => ({
      name: p.name,
      locations: p.songs.filter((s) => ready.has(s.id)).map((s) => location.get(s.id) as string),
    }))
    .filter((p) => p.locations.length > 0);

  if (tracks.length === 0) { return summary; }
  // The download can take a while; rekordbox may have been opened meanwhile.
  if (deps.isRekordboxRunning()) {
    throw new Error(`${REKORDBOX_OPEN} The files are downloaded and will be used as they are on the next import.`);
  }

  deps.onProgress({ operationId, phase: 'writing', current: 0, total: tracks.length, currentFile: '' });
  const written = deps.writeDb(tracks, playlists);
  summary.tracksAdded = written.tracksAdded;
  summary.tracksAlreadyThere = written.tracksAlreadyThere;
  summary.playlists = written.playlists.map((p) => ({ name: p.name, tracks: p.tracks }));
  summary.backupPath = written.backupPath;
  summary.playlistFileUpdated = written.playlistFileUpdated;
  summary.playlistFileProblem = written.playlistFileProblem;
  return summary;
}
