import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.unmock('fs');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runNavidromeImport, type ImportDeps } from '../../src/main/navidrome/importRun';
import type { SubsonicSong } from '../../src/main/navidrome/subsonic';
import type { NavidromeImportRequest } from '../../src/main/ipcContract';
import type { ConversionPlan, ConversionResult } from '../../src/main/audioConverter';

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
    contentIds: tracks.map((_t: any, i: number) => String(100 + i)),
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

  describe('converting to AIFF', () => {
    /** FLAC, WAV and M4A from the server, and an MP3 and an AIFF that stay as they are. */
    const mixed = () => {
      const files = { f: 'flac', w: 'wav', m: 'm4a', p: 'mp3', a: 'aiff' } as const;
      const songs = Object.fromEntries(Object.entries(files).map(([id, suffix]) => [id, song(id, { suffix, path: `Artist/Album/${id}.${suffix}` })]));
      const d = deps();
      d.client.song = vi.fn(async (id: string) => songs[id]) as any;
      return d;
    };
    /** Converts like the real thing: an AIFF beside each source, unless told to fail. */
    const converter = (fail: string[] = []) => vi.fn(async (plan: ConversionPlan): Promise<ConversionResult> => {
      const result: ConversionResult = { converted: [], skipped: [...plan.skipped], failed: [], cancelled: false };
      for (const job of plan.jobs) {
        if (fail.some((f) => job.source.endsWith(f))) { result.failed.push({ file: job.source, error: 'ffmpeg said no' }); continue; }
        fs.writeFileSync(job.destination, 'aiff audio');
        result.converted.push({
          trackIds: job.trackIds, oldLocation: job.source, newLocation: job.destination, format: 'aiff',
          size: 10, sampleRate: 48000, bitDepth: 24, bitRate: 2304,
        });
      }
      return result;
    });
    const at = (name: string) => path.join(dest, 'Artist', 'Album', name);
    const convertRequest = () => request({ playlistIds: [], songIds: ['f', 'w', 'm', 'p', 'a'], convertToAiff: true, workers: 2 });

    it('imports FLAC, WAV and M4A as AIFF, and MP3 and AIFF as they are', async () => {
      const convertToAiff = converter();
      const d = { ...mixed(), convertToAiff, removeFile: vi.fn(async (f: string) => fs.rmSync(f)) };
      const out = await runNavidromeImport(convertRequest(), d);

      const plan = convertToAiff.mock.calls[0][0];
      expect(plan.jobs.map((j) => path.basename(j.source))).toEqual(['f.flac', 'w.wav', 'm.m4a']);
      expect(convertToAiff.mock.calls[0][3]).toBe(2);
      const [tracks] = d.writeDb.mock.calls[0];
      expect(tracks.map((t: any) => [path.basename(t.location), t.fileType])).toEqual([
        ['f.aiff', 12], ['w.aiff', 12], ['m.aiff', 12], ['p.mp3', 1], ['a.aiff', 12],
      ]);
      expect(tracks[0]).toMatchObject({ fileSize: 10, sampleRate: 48000, bitDepth: 24, bitRate: 2304 });
      expect(out).toMatchObject({ convertedToAiff: 3, notConverted: [], trackIds: ['100', '101', '102', '103', '104'] });
    });

    it('removes each original it downloaded, once the database points at its AIFF', async () => {
      const removeFile = vi.fn(async (f: string) => fs.rmSync(f));
      await runNavidromeImport(convertRequest(), { ...mixed(), convertToAiff: converter(), removeFile });
      expect(removeFile.mock.calls.map((c) => path.basename(c[0])).sort()).toEqual(['f.flac', 'm.m4a', 'w.wav']);
      expect(fs.existsSync(at('f.flac'))).toBe(false);
      expect(fs.existsSync(at('f.aiff'))).toBe(true);
      expect(fs.existsSync(at('p.mp3'))).toBe(true);
    });

    it('never removes a file that was in the folder before', async () => {
      // It may be the user's own, or a track an earlier import added as FLAC.
      fs.mkdirSync(path.dirname(at('f.flac')), { recursive: true });
      fs.writeFileSync(at('f.flac'), 'audio');
      const removeFile = vi.fn(async (f: string) => fs.rmSync(f));
      await runNavidromeImport(convertRequest(), { ...mixed(), convertToAiff: converter(), removeFile });
      expect(fs.existsSync(at('f.flac'))).toBe(true);
      expect(removeFile.mock.calls.map((c) => path.basename(c[0])).sort()).toEqual(['m.m4a', 'w.wav']);
    });

    it('imports a file that would not convert as it is, and says so', async () => {
      const removeFile = vi.fn(async (f: string) => fs.rmSync(f));
      const d = { ...mixed(), convertToAiff: converter(['w.wav']), removeFile };
      const out = await runNavidromeImport(convertRequest(), d);
      const [tracks] = d.writeDb.mock.calls[0];
      expect(tracks.find((t: any) => t.location === at('w.wav'))).toMatchObject({ fileType: 11 });
      expect(out.notConverted).toEqual([{ title: 'Artist — Title w', reason: 'ffmpeg said no' }]);
      expect(fs.existsSync(at('w.wav'))).toBe(true);
    });

    it('puts the AIFF in the playlist', async () => {
      const d = { ...deps(), convertToAiff: converter(), removeFile: vi.fn(async () => undefined) };
      d.client.playlist = vi.fn(async () => ({ name: 'Peak', songs: [song('f', { suffix: 'flac', path: 'Artist/Album/f.flac' })] })) as any;
      await runNavidromeImport(request({ songIds: [], convertToAiff: true }), d);
      const [, lists] = d.writeDb.mock.calls[0];
      expect(lists[0].locations).toEqual([at('f.aiff')]);
    });

    it('writes and removes nothing when cancelled while converting', async () => {
      const token = { cancelled: false };
      const removeFile = vi.fn(async () => undefined);
      const convertToAiff = vi.fn(async (plan: ConversionPlan): Promise<ConversionResult> => {
        token.cancelled = true;
        return { converted: [], skipped: plan.skipped, failed: [], cancelled: true };
      });
      const d = { ...mixed(), cancelToken: token, convertToAiff, removeFile };
      const out = await runNavidromeImport(convertRequest(), d);
      expect(out.cancelled).toBe(true);
      expect(d.writeDb).not.toHaveBeenCalled();
      expect(removeFile).not.toHaveBeenCalled();
    });

    it('refuses to start without an ffmpeg to convert with', async () => {
      const d = mixed();
      await expect(runNavidromeImport(convertRequest(), d)).rejects.toThrow(/no ffmpeg/);
      expect(d.download).not.toHaveBeenCalled();
    });

    it('converts nothing unless asked', async () => {
      const convertToAiff = converter();
      const d = { ...mixed(), convertToAiff };
      await runNavidromeImport({ ...convertRequest(), convertToAiff: false }, d);
      expect(convertToAiff).not.toHaveBeenCalled();
      expect(d.writeDb.mock.calls[0][0].map((t: any) => path.extname(t.location))).toEqual(['.flac', '.wav', '.m4a', '.mp3', '.aiff']);
    });
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
