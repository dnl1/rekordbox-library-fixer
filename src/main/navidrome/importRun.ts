import * as fs from 'fs';
import * as path from 'path';
import type { SubsonicClient, SubsonicSong } from './subsonic';
import { downloadToFile, fileTypeFor, plannedPath } from './importFiles';
import type { DbImportSummary, ImportPlaylist, ImportTrack } from '../rekordboxDbImport';
import { runPool } from '../workerPool';
import {
  isConvertible, planConversions, type CancelToken, type ConversionPlan, type ConversionProgress,
  type ConversionResult, type ConvertedFile,
} from '../audioConverter';
import { REKORDBOX_FILE_TYPE } from '../rekordboxDbConverter';
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
 *
 * Asked to, the FLAC, WAV and M4A files become AIFF before anything is
 * written, and the AIFF is what rekordbox gets. Each original this run
 * downloaded goes once the database points at its AIFF — the server still has
 * it. A file that was already in the folder is never removed: it may be the
 * user's own, or a track an earlier import added as it was.
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
  /** Converts to AIFF, as Convert audio does; absent when this build has no ffmpeg. */
  convertToAiff?: (
    plan: ConversionPlan,
    onProgress: (p: ConversionProgress) => void,
    cancelToken: CancelToken,
    workers?: number,
  ) => Promise<ConversionResult>;
  removeFile?: (file: string) => Promise<void>;
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
  if (request.convertToAiff && !deps.convertToAiff) {
    throw new Error('This build of the app has no ffmpeg for this platform, so it cannot convert to AIFF. Import without converting instead.');
  }

  const summary: NavidromeImportSummary = {
    downloaded: 0, reused: 0, skipped: [], failed: [], tracksAdded: 0, tracksAlreadyThere: 0,
    trackIds: [], convertedToAiff: 0, notConverted: [],
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
  /** Songs whose file this run created: the only originals it may remove. */
  const freshDownloads = new Set<string>();
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
        if (existing < 0) { freshDownloads.add(song.id); }
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

  // Convert, a few at a time, before anything is written: a cancel here still
  // adds nothing, and the next run checks each AIFF against its original.
  const aiffOf = new Map<string, ConvertedFile>();
  if (request.convertToAiff && deps.convertToAiff) {
    const sources = plan.filter(({ song, target }) => ready.has(song.id) && isConvertible(target, 'aiff'));
    const conversion = planConversions(
      sources.map(({ song, target }) => ({ id: song.id, location: target, size: ready.get(song.id) })), 'aiff',
    );
    deps.onProgress({ operationId, phase: 'converting', current: 0, total: conversion.jobs.length, currentFile: '' });
    const result = await deps.convertToAiff(
      conversion,
      (p) => deps.onProgress({ operationId, phase: 'converting', current: p.current, total: p.total, currentFile: p.currentFile }),
      deps.cancelToken,
      request.workers,
    );
    if (deps.cancelToken.cancelled || result.cancelled) {
      summary.cancelled = true;
      return summary;
    }
    for (const file of result.converted) {
      for (const id of file.trackIds) { aiffOf.set(id, file); }
    }
    const songOf = new Map(sources.map(({ song, target }) => [target, song]));
    for (const failure of result.failed) {
      const song = songOf.get(failure.file);
      summary.notConverted.push({ title: song ? describe(song) : failure.file, reason: failure.error });
    }
    for (const skip of result.skipped) {
      const song = songs.get(skip.trackId);
      summary.notConverted.push({ title: song ? describe(song) : skip.location, reason: skip.reason });
    }
  }

  const tracks: ImportTrack[] = plan
    .filter(({ song }) => ready.has(song.id))
    .map(({ song, target, fileType }) => {
      const aiff = aiffOf.get(song.id);
      return {
        location: aiff ? aiff.newLocation : target,
        title: song.title,
        artist: song.artist || undefined,
        album: song.album || undefined,
        genre: song.genre || undefined,
        year: song.year,
        trackNo: song.track,
        discNo: song.discNumber,
        length: song.duration,
        bitRate: aiff ? aiff.bitRate : song.bitRate,
        sampleRate: aiff ? aiff.sampleRate : song.samplingRate,
        bitDepth: aiff ? aiff.bitDepth : song.bitDepth,
        fileSize: aiff ? aiff.size : ready.get(song.id) as number,
        fileType: aiff ? REKORDBOX_FILE_TYPE.aiff : fileType,
      };
    });
  summary.convertedToAiff = plan.filter(({ song }) => ready.has(song.id) && aiffOf.has(song.id)).length;
  const location = new Map(plan.map(({ song, target }) => [song.id, aiffOf.get(song.id)?.newLocation ?? target]));
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
  summary.trackIds = written.contentIds;

  // Only now, with the database pointing at the AIFFs: the originals this run
  // downloaded. Removing one that fails to go costs only disk space.
  const originals = new Set([...aiffOf].filter(([id]) => freshDownloads.has(id)).map(([, file]) => file.oldLocation));
  for (const original of originals) {
    try { await deps.removeFile?.(original); } catch { /* left in the folder; nothing points at it */ }
  }
  summary.playlists = written.playlists.map((p) => ({ name: p.name, tracks: p.tracks }));
  summary.backupPath = written.backupPath;
  summary.playlistFileUpdated = written.playlistFileUpdated;
  summary.playlistFileProblem = written.playlistFileProblem;
  return summary;
}
