import { spawn } from 'child_process';
import type { GridBeat } from './anlzReader';
import type { CancelToken } from './flacConverter';

/**
 * Find the drops in a track by its bass: where the kick and the bassline come
 * back in full after a breakdown.
 *
 * rekordbox's phrase analysis names the high-energy parts of dance music
 * "Chorus", but most of them are not drops — the bass was already there, and
 * the phrase only carries on. What sets a drop apart is the stretch before
 * it: a breakdown runs eight to thirty-two bars with the low end pulled back,
 * while a cut in a build-up lasts a bar or two. So the bass below ~120 Hz is
 * measured bar by bar along rekordbox's beatgrid, and a drop is a bar where it
 * returns in full after at least eight bars held down.
 *
 * The thresholds were tuned by ear on a real psytrance library; the two
 * obvious rules around them both failed there. "Bass gone for four bars"
 * found almost nothing — a psy breakdown rarely silences the bass outright —
 * and "bass reduced for four bars" called every build-up cut a drop.
 */

/** Low enough to hold the kick and the bassline, high enough for a 120 Hz low-pass. */
export const BASS_SAMPLE_RATE = 2000;

const BEATS_PER_BAR = 4;
/** Bars held down before a drop: a breakdown, not a cut in a build-up. */
const BREAKDOWN_BARS = 8;
/** Of those, how many must be clearly below full. */
const BREAKDOWN_MIN_LOW_BARS = 6;
/** dB against the loud bars: the breakdown's average, a bar that counts as low, a bar that counts as full. */
const BREAKDOWN_MEAN_DB = -8;
const LOW_BAR_DB = -6;
const FULL_BAR_DB = -4;
/** A drop is snapped to a phrase start this close — two bars — as rekordbox's phrases are on the beat. */
const SNAP_BEATS = 8;
/** Two drops closer than eight bars are one. */
const MIN_BEATS_APART = 32;

/** The ffmpeg command that writes the bass as mono 32-bit floats to stdout. */
export function bassArgs(file: string): string[] {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-map', '0:a:0',
    // Two passes: one 12 dB/octave low-pass lets too much of the mids through.
    '-af', 'lowpass=f=120,lowpass=f=120', '-ac', '1', '-ar', String(BASS_SAMPLE_RATE), '-f', 'f32le', '-',
  ];
}

/** The bass of one file, decoded with the bundled ffmpeg. */
export function decodeBass(ffmpegPath: string, file: string, cancelToken: CancelToken): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, bassArgs(file), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    const watch = setInterval(() => { if (cancelToken.cancelled) { child.kill(); } }, 200);
    child.on('error', (error) => { clearInterval(watch); reject(error); });
    child.on('close', (code) => {
      clearInterval(watch);
      if (cancelToken.cancelled) { reject(new Error('cancelled')); return; }
      if (code !== 0) { reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with code ${code}`)); return; }
      const data = Buffer.concat(chunks);
      // Copied onto an aligned buffer: a Float32Array cannot view an odd offset.
      const aligned = new Uint8Array(data.length - (data.length % 4));
      aligned.set(data.subarray(0, aligned.length));
      resolve(new Float32Array(aligned.buffer));
    });
  });
}

/**
 * The bass level of each whole bar, in dB against the track's loud bars (its
 * 90th percentile), so a quiet master and a loud one read alike. Bar `i`
 * starts on beat `i × 4 + 1` of the grid.
 */
export function barLevels(samples: Float32Array, grid: GridBeat[], sampleRate = BASS_SAMPLE_RATE): number[] {
  const rms: number[] = [];
  for (let i = 0; i + BEATS_PER_BAR < grid.length; i += BEATS_PER_BAR) {
    const from = Math.floor((grid[i].time * sampleRate) / 1000);
    const to = Math.min(samples.length, Math.floor((grid[i + BEATS_PER_BAR].time * sampleRate) / 1000));
    let sum = 0;
    for (let s = from; s < to; s++) { sum += samples[s] * samples[s]; }
    rms.push(Math.sqrt(to > from ? sum / (to - from) : 0) + 1e-9);
  }
  if (rms.length === 0) { return []; }
  const sorted = [...rms].sort((a, b) => a - b);
  const loud = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  return rms.map((v) => 20 * Math.log10(v / loud));
}

/** The beats (1-based) where a drop starts, snapped to rekordbox's phrase starts. */
export function findDrops(levels: number[], phraseStarts: number[]): number[] {
  const drops: number[] = [];
  for (let i = BREAKDOWN_BARS; i + 1 < levels.length; i++) {
    const before = levels.slice(i - BREAKDOWN_BARS, i);
    const mean = before.reduce((sum, v) => sum + v, 0) / before.length;
    const low = before.filter((v) => v < LOW_BAR_DB).length;
    if (mean >= BREAKDOWN_MEAN_DB || low < BREAKDOWN_MIN_LOW_BARS) { continue; }
    if (levels[i] <= FULL_BAR_DB || levels[i + 1] <= FULL_BAR_DB) { continue; }

    let beat = i * BEATS_PER_BAR + 1;
    const nearest = phraseStarts.reduce<number | null>(
      (best, start) => (best === null || Math.abs(start - beat) < Math.abs(best - beat) ? start : best), null
    );
    if (nearest !== null && Math.abs(nearest - beat) <= SNAP_BEATS) { beat = nearest; }
    if (drops.length === 0 || beat - drops[drops.length - 1] > MIN_BEATS_APART) { drops.push(beat); }
  }
  return drops;
}
