import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
vi.unmock('fs');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { barLevels, findDrops, decodeBass, BASS_SAMPLE_RATE } from '../../src/main/bassDrops';
import { resolveFfmpegPath } from '../../src/main/ffmpegBinary';
import type { GridBeat } from '../../src/main/anlzReader';

const grid = (beats: number, bpm = 120): GridBeat[] =>
  Array.from({ length: beats }, (_, i) => ({ beat: (i % 4) + 1, tempo: bpm * 100, time: Math.round((i * 60000) / bpm) }));

/** Levels in dB per bar: full is 0, a breakdown -12. */
const bars = (spec: Array<[number, number]>) => spec.flatMap(([count, db]) => Array<number>(count).fill(db));

describe('findDrops', () => {
  it('finds the bass returning after a breakdown of eight bars', () => {
    const levels = bars([[16, 0], [8, -12], [8, 0]]);
    expect(findDrops(levels, [])).toEqual([24 * 4 + 1]);
  });

  it('does not call a cut of a bar or two in a build-up a drop', () => {
    expect(findDrops(bars([[16, 0], [2, -20], [16, 0]]), [])).toEqual([]);
  });

  it('counts a breakdown that keeps some bass — psy rarely silences it', () => {
    // Half-level bass (-9 dB) for twelve bars, then full.
    expect(findDrops(bars([[8, 0], [12, -9], [8, 0]]), [])).toEqual([20 * 4 + 1]);
  });

  it('needs the bass full for two bars, not one hit', () => {
    expect(findDrops(bars([[8, 0], [8, -12], [1, 0], [8, -12]]), [])).toEqual([]);
  });

  it('snaps to a rekordbox phrase start within two bars, and not further', () => {
    const levels = bars([[8, 0], [8, -12], [8, 0]]);
    expect(findDrops(levels, [61])).toEqual([61]);
    expect(findDrops(levels, [49])).toEqual([65]);
  });
});

describe('barLevels', () => {
  it('measures each whole bar against the loud ones', () => {
    const g = grid(17);
    const samples = new Float32Array(Math.ceil((g[16].time / 1000) * BASS_SAMPLE_RATE));
    const barLength = (2000 / 1000) * BASS_SAMPLE_RATE;
    for (let s = 0; s < samples.length; s++) { samples[s] = s < barLength * 2 ? 0.05 : 0.5; }
    const levels = barLevels(samples, g);
    expect(levels).toHaveLength(4);
    expect(levels[0]).toBeCloseTo(-20, 0);
    expect(levels[3]).toBeCloseTo(0, 5);
  });
});

// ─── The real thing, with the bundled ffmpeg ─────────────────────────────────

const ffmpeg = resolveFfmpegPath({
  isPackaged: false, resourcesPath: '', appPath: path.resolve(__dirname, '../..'),
  platform: process.platform, arch: process.arch,
});

describe.skipIf(!ffmpeg)('decodeBass with the bundled ffmpeg', () => {
  let dir: string;
  let file: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bassdrops-'));
    file = path.join(dir, 'track.flac');
    // 120 BPM: a bar is 2 s. 16 bars with a 50 Hz bass, 8 bars with only a 2 kHz lead, 8 bars with the bass back.
    const run = (args: string[]) => execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    run(['-f', 'lavfi', '-i', 'sine=frequency=50:duration=32', '-f', 'lavfi', '-i', 'sine=frequency=2000:duration=16',
      '-f', 'lavfi', '-i', 'sine=frequency=50:duration=16',
      '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', '-c:a', 'flac', file]);
  });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('hears the lead as no bass, and finds the drop where the bass comes back', async () => {
    const samples = await decodeBass(ffmpeg!, file, { cancelled: false });
    expect(samples.length).toBeGreaterThan(60 * BASS_SAMPLE_RATE);
    expect(findDrops(barLevels(samples, grid(129)), [])).toEqual([24 * 4 + 1]);
  });

  it('stops when cancelled', async () => {
    await expect(decodeBass(ffmpeg!, file, { cancelled: true })).rejects.toThrow(/cancelled/);
  });
});
