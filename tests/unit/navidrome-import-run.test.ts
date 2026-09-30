import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.unmock('fs');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runNavidromeImport, type ImportDeps } from '../../src/main/navidrome/importRun';
import type { SubsonicSong } from '../../src/main/navidrome/subsonic';
import type { NavidromeImportRequest } from '../../src/main/ipcContract';

const song = (id: string, over: Partial<SubsonicSong> = {}): SubsonicSong => ({
  id, title: `Title ${id}`, artist: 'Artist', album: 'Album', genre: 'Techno', suffix: 'mp3', size: 5,
  path: `Artist/Album/${id}.mp3`, duration: 300, bitRate: 320, samplingRate: 44100, ...over,
});

let dest: string;
beforeEach(() => { dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ndr-')); });
afterEach(() => { fs.rmSync(dest, { recursive: true, force: true }); });

function deps(over: Partial<ImportDeps> = {}) {
  const playlists: Record<string, { name: string; songs: SubsonicSong[] }> = {
    p1: { name: 'Peak', songs: [song('a'), song('b'), song('c', { suffix: 'ogg', path: 'Artist/Album/c.ogg' })] },
  };
  const songs: Record<string, SubsonicSong> = { b: song('b'), d: song('d') };
  const client = {
    baseUrl: 'https://nd',
    playlist: vi.fn(async (id: string) => playlists[id]),
    song: vi.fn(async (id: string) => songs[id]),
    downloadUrl: (id: string) => `https://nd/rest/download.view?id=${id}`,
  } as unknown as ImportDeps['client'];
  const download = vi.fn(async (_url: string, target: string) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'audio');
    return 5;
  }) as unknown as ImportDeps['download'];
  const writeDb = vi.fn((tracks: any[], lists: any[]) => ({
    tracksAdded: tracks.length, tracksAlreadyThere: 0, backupPath: '/b', playlistFileUpdated: true,
    playlists: lists.map((l: any, i: number) => ({ id: String(i + 1), name: l.name, tracks: l.locations.length, timestamp: 0 })),
  }));
  return {
    client, download, writeDb, isRekordboxRunning: vi.fn(() => false), onProgress: vi.fn(),
    cancelToken: { cancelled: false }, ...over,
  } as ImportDeps & { writeDb: ReturnType<typeof vi.fn>; download: ReturnType<typeof vi.fn> };
}

const request = (over: Partial<NavidromeImportRequest> = {}): NavidromeImportRequest => ({
  operationId: 'op', libraryPath: '/pioneer/master.db', dbKey: 'k', destination: dest, playlistIds: ['p1'], songIds: ['b', 'd'], ...over,
});

describe('runNavidromeImport', () => {
  it('fetches each song once, keeps the server\'s folders, and writes the tracks and the playlist', async () => {
    const d = deps();
    const out = await runNavidromeImport(request(), d);

    expect(d.download).toHaveBeenCalledTimes(3); // a, b, d — b is in the playlist and was picked too
    expect(out).toMatchObject({ downloaded: 3, reused: 0, tracksAdded: 3, playlists: [{ name: 'Peak', tracks: 2 }], cancelled: false });
    const [tracks, lists] = d.writeDb.mock.calls[0];
    expect(tracks.map((t: any) => t.location)).toEqual(['a', 'b', 'd'].map((id) => path.join(dest, 'Artist', 'Album', `${id}.mp3`)));
    expect(tracks[0]).toMatchObject({ title: 'Title a', artist: 'Artist', length: 300, bitRate: 320, sampleRate: 44100, fileSize: 5, fileType: 1 });
    expect(lists).toEqual([{ name: 'Peak', locations: [path.join(dest, 'Artist', 'Album', 'a.mp3'), path.join(dest, 'Artist', 'Album', 'b.mp3')] }]);
  });

  it('leaves out what rekordbox cannot play, and says so', async () => {
    const out = await runNavidromeImport(request(), deps());
    expect(out.skipped).toEqual([{ title: 'Artist — Title c', reason: 'rekordbox cannot play .ogg files' }]);
  });

  it('reads picked songs from the server rather than trusting what the page sent', async () => {
    const d = deps();
    await runNavidromeImport(request({ playlistIds: [] }), d);
    expect(d.client.song).toHaveBeenCalledWith('b');
    expect(d.client.song).toHaveBeenCalledWith('d');
  });

  it('uses a file an earlier run already fetched', async () => {
    const existing = path.join(dest, 'Artist', 'Album', 'a.mp3');
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, 'audio'); // 5 bytes, as the server reports
    const d = deps();
    const out = await runNavidromeImport(request({ songIds: [] }), d);
    expect(out).toMatchObject({ reused: 1, downloaded: 1 });
    expect(d.download).toHaveBeenCalledTimes(1);
  });

  it('fetches again a file of the wrong size', async () => {
    const existing = path.join(dest, 'Artist', 'Album', 'a.mp3');
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, 'half');
    const out = await runNavidromeImport(request({ songIds: [] }), deps());
    expect(out).toMatchObject({ reused: 0, downloaded: 2 });
  });

  it('reports a failed download and imports the rest, the playlist without it', async () => {
    const d = deps();
    d.download.mockImplementationOnce(async () => { throw new Error('connection reset'); });
    const out = await runNavidromeImport(request({ songIds: [] }), d);
    expect(out.failed).toEqual([{ title: 'Artist — Title a', error: 'connection reset' }]);
    const [, lists] = d.writeDb.mock.calls[0];
    expect(lists[0].locations).toEqual([path.join(dest, 'Artist', 'Album', 'b.mp3')]);
  });

  it('refuses to start while rekordbox is open', async () => {
    const d = deps({ isRekordboxRunning: () => true });
    await expect(runNavidromeImport(request(), d)).rejects.toThrow(/Close rekordbox first/);
    expect(d.client.playlist).not.toHaveBeenCalled();
  });

  it('writes nothing when rekordbox was opened during the download, and keeps the files', async () => {
    let calls = 0;
    const d = deps({ isRekordboxRunning: () => calls++ > 0 });
    await expect(runNavidromeImport(request(), d)).rejects.toThrow(/files are downloaded and will be used/);
    expect(d.writeDb).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dest, 'Artist', 'Album', 'a.mp3'))).toBe(true);
  });

  it('writes nothing once cancelled', async () => {
    const token = { cancelled: false };
    const d = deps({ cancelToken: token });
    d.download.mockImplementation(async (_u: string, target: string) => {
      token.cancelled = true;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'audio');
      return 5;
    });
    const out = await runNavidromeImport(request(), d);
    expect(out.cancelled).toBe(true);
    expect(d.writeDb).not.toHaveBeenCalled();
  });

  it('needs a folder to download to', async () => {
    await expect(runNavidromeImport(request({ destination: 'relative/dir' }), deps())).rejects.toThrow(/Choose the folder/);
  });

  it('reports progress as it goes', async () => {
    const d = deps();
    await runNavidromeImport(request(), d);
    const phases = (d.onProgress as any).mock.calls.map((c: any[]) => c[0].phase);
    expect(phases[0]).toBe('listing');
    expect(phases).toContain('downloading');
    expect(phases[phases.length - 1]).toBe('writing');
  });
});
