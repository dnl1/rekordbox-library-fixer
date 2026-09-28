import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
vi.unmock('fs');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { planFlacCleanup, flacBeside, cleanupFlacs, type CleanupDeps } from '../../src/main/flacCleanup';
import { FlacConverter } from '../../src/main/flacConverter';
import { resolveFfmpegPath } from '../../src/main/ffmpegBinary';

const on = (...files: string[]) => (p: string) => files.includes(p);

describe('flacBeside', () => {
  it('finds the FLAC beside an AIFF, an AIF or a WAV', () => {
    expect(flacBeside('/m/a.aiff', on('/m/a.flac'))).toBe('/m/a.flac');
    expect(flacBeside('/m/a.AIF', on('/m/a.flac'))).toBe('/m/a.flac');
    expect(flacBeside('/m/a.wav', on('/m/a.FLAC'))).toBe('/m/a.FLAC');
  });

  it('never treats an MP3 as a replacement — it is lossy', () => {
    expect(flacBeside('/m/a.mp3', on('/m/a.flac'))).toBeNull();
  });

  it('keeps the library spelling of a Windows path', () => {
    expect(flacBeside('C:/Music/a.aiff', on('C:/Music/a.flac'))).toBe('C:/Music/a.flac');
  });
});

describe('planFlacCleanup', () => {
  const exists = on('/m/a.aiff', '/m/a.flac', '/m/b.aiff', '/m/b.flac', '/m/c.flac');

  it('offers a FLAC no entry uses, beside an AIFF one does', () => {
    const plan = planFlacCleanup([{ id: '1', location: '/m/a.aiff' }], exists);
    expect(plan.candidates).toEqual([{ flac: '/m/a.flac', converted: '/m/a.aiff', trackIds: ['1'] }]);
  });

  it('never offers a FLAC an entry still points at', () => {
    const plan = planFlacCleanup([
      { id: '1', location: '/m/b.aiff' },
      { id: '2', location: '/m/b.flac' },
    ], exists);
    expect(plan.candidates).toEqual([]);
    expect(plan.stillUsed).toBe(1);
  });

  it('sees an entry for the FLAC however its accents or case are spelled', () => {
    const decomposed = '/m/Cafe\u0301.aiff';
    const plan = planFlacCleanup([
      { id: '1', location: decomposed },
      { id: '2', location: '/M/CAF\u00c9.FLAC' },
    ], on(decomposed, '/m/Cafe\u0301.flac'));
    expect(plan.candidates).toEqual([]);
  });

  it('ignores a FLAC with no conversion beside it, and a conversion whose file is gone', () => {
    expect(planFlacCleanup([{ id: '1', location: '/m/c.flac' }], exists).candidates).toEqual([]);
    expect(planFlacCleanup([{ id: '1', location: '/m/gone.aiff' }], on('/m/gone.flac')).candidates).toEqual([]);
  });

  it('lists a FLAC once when several entries use its conversion', () => {
    const plan = planFlacCleanup([
      { id: '1', location: '/m/a.aiff' },
      { id: '2', location: '/m/a.aiff' },
    ], exists);
    expect(plan.candidates).toEqual([{ flac: '/m/a.flac', converted: '/m/a.aiff', trackIds: ['1', '2'] }]);
  });

  it('leaves streaming entries alone', () => {
    expect(planFlacCleanup([{ id: '1', location: 'tidal:tracks:1' }], () => true).candidates).toEqual([]);
  });
});

describe('cleanupFlacs', () => {
  const plan = {
    candidates: [
      { flac: '/m/a.flac', converted: '/m/a.aiff', trackIds: ['1'] },
      { flac: '/m/b.flac', converted: '/m/b.aiff', trackIds: ['2'] },
    ],
    stillUsed: 0,
  };
  const deps = (over: Partial<CleanupDeps> = {}): CleanupDeps => ({
    sameAudio: async () => null,
    currentLocations: async () => ['/m/a.aiff', '/m/b.aiff'],
    trash: vi.fn(async () => undefined),
    size: () => 100,
    ...over,
  });

  it('trashes each FLAC proved identical and counts what it frees', async () => {
    const d = deps();
    const out = await cleanupFlacs(plan, d, () => {}, { cancelled: false });
    expect(out.trashed).toEqual(['/m/a.flac', '/m/b.flac']);
    expect(out.freedBytes).toBe(200);
    expect(d.trash).toHaveBeenCalledTimes(2);
  });

  it('keeps a FLAC whose audio differs from the file beside it', async () => {
    const d = deps({ sameAudio: async (flac) => (flac === '/m/b.flac' ? 'the audio differs' : null) });
    const out = await cleanupFlacs(plan, d, () => {}, { cancelled: false });
    expect(out.trashed).toEqual(['/m/a.flac']);
    expect(out.kept[0]).toMatchObject({ file: '/m/b.flac', reason: expect.stringMatching(/the audio differs/) });
  });

  it('re-reads the collection and keeps a FLAC an entry was pointed at meanwhile', async () => {
    const d = deps({ currentLocations: async () => ['/m/a.aiff', '/m/b.aiff', '/m/b.flac'] });
    const out = await cleanupFlacs(plan, d, () => {}, { cancelled: false });
    expect(out.trashed).toEqual(['/m/a.flac']);
    expect(out.kept).toEqual([{ file: '/m/b.flac', reason: 'an entry points at it now' }]);
  });

  it('keeps a FLAC whose conversion no entry uses any more — it may be the only copy in the library', async () => {
    const d = deps({ currentLocations: async () => ['/m/a.aiff'] });
    const out = await cleanupFlacs(plan, d, () => {}, { cancelled: false });
    expect(out.trashed).toEqual(['/m/a.flac']);
    expect(out.kept[0].file).toBe('/m/b.flac');
  });

  it('trashes nothing once cancelled, not even what it already proved', async () => {
    const token = { cancelled: false };
    const d = deps({ sameAudio: async () => { token.cancelled = true; return null; } });
    const out = await cleanupFlacs(plan, d, () => {}, token);
    expect(out.cancelled).toBe(true);
    expect(d.trash).not.toHaveBeenCalled();
  });

  it('reports a file the trash refused and carries on', async () => {
    const d = deps({ trash: vi.fn(async (f: string) => { if (f === '/m/a.flac') { throw new Error('locked'); } }) });
    const out = await cleanupFlacs(plan, d, () => {}, { cancelled: false });
    expect(out.failed).toEqual([{ file: '/m/a.flac', error: 'locked' }]);
    expect(out.trashed).toEqual(['/m/b.flac']);
    expect(out.freedBytes).toBe(100);
  });
});

// ─── The audio comparison, with the bundled ffmpeg ───────────────────────────

const ffmpeg = resolveFfmpegPath({
  isPackaged: false,
  resourcesPath: '',
  appPath: path.resolve(__dirname, '../..'),
  platform: process.platform,
  arch: process.arch,
});

describe.skipIf(!ffmpeg)('FlacConverter.sameAudio with the bundled ffmpeg', () => {
  let dir: string;
  const run = (args: string[]) => execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const tone = (freq: number, out: string, codec: string[]) =>
    run(['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=1:sample_rate=44100`, '-ac', '2', ...codec, out]);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flaccleanup-'));
    tone(440, path.join(dir, 'a.flac'), ['-c:a', 'flac', '-sample_fmt', 's16']);
    run(['-i', path.join(dir, 'a.flac'), '-c:a', 'pcm_s16be', path.join(dir, 'a.aiff')]);
    run(['-i', path.join(dir, 'a.flac'), '-c:a', 'pcm_s24be', path.join(dir, 'a24.aiff')]);
    tone(880, path.join(dir, 'b.aiff'), ['-c:a', 'pcm_s16be']);
  });

  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const converter = () => new FlacConverter(ffmpeg!);

  it('matches a FLAC with its AIFF', async () => {
    expect(await converter().sameAudio(path.join(dir, 'a.flac'), path.join(dir, 'a.aiff'), { cancelled: false })).toBeNull();
  });

  it('matches a 16-bit FLAC with a 24-bit AIFF another tool made of it', async () => {
    expect(await converter().sameAudio(path.join(dir, 'a.flac'), path.join(dir, 'a24.aiff'), { cancelled: false })).toBeNull();
  });

  it('tells apart two recordings of the same length and shape', async () => {
    expect(await converter().sameAudio(path.join(dir, 'a.flac'), path.join(dir, 'b.aiff'), { cancelled: false }))
      .toBe('the audio differs');
  });
});
