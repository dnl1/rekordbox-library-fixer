import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { IAudioMetadata, IOptions } from 'music-metadata';
import { isStreamingLocation } from './brokenEntries';

/**
 * Convert FLAC files to AIFF, WAV or MP3 with the bundled ffmpeg.
 *
 * FLAC plays on current players but not on older CDJs and XDJs, and a DJ with
 * a FLAC collection finds out at the club. AIFF and WAV are uncompressed PCM
 * decoded from a lossless source, so that conversion is sample-exact: no
 * encoder delay moves the audio, and every cue, loop and beatgrid stored in
 * milliseconds still lands where it did.
 *
 * AIFF is the better of the two. It carries ID3 tags and artwork, which
 * rekordbox reads; WAV keeps only a RIFF INFO list, which rekordbox largely
 * ignores. For a database-backed library that matters less — the metadata
 * lives in the database, not the file — but it matters to anything else that
 * opens it.
 *
 * MP3 is for space: a USB stick, a player with a small card. It is 320 kbps
 * constant bit rate, because older CDJs misread the length of a variable-rate
 * file and seek to the wrong place in it. It is not sample-exact — the encoder
 * adds a little silence at the start, and players that ignore the gapless
 * header hear cues a few milliseconds late — and it is lossy, so the FLAC is
 * the only lossless copy there is.
 */

export type ConversionFormat = 'aiff' | 'wav' | 'mp3';

export const isLosslessFormat = (format: ConversionFormat): boolean => format !== 'mp3';

export const MP3_BITRATE_KBPS = 320;

export interface ConvertibleTrack {
  id: string;
  location: string;
  size?: number;
}

/** One file to convert, and every library entry that points at it. */
export interface ConversionJob {
  source: string;
  destination: string;
  trackIds: string[];
  size?: number;
}

export interface ConversionSkip {
  trackId: string;
  location: string;
  kind: 'missing' | 'exists';
  reason: string;
}

export interface ConversionPlan {
  jobs: ConversionJob[];
  skipped: ConversionSkip[];
}

export interface ConvertedFile {
  trackIds: string[];
  oldLocation: string;
  newLocation: string;
  format: ConversionFormat;
  size: number;
  sampleRate: number;
  bitDepth: number;
  /** kbps, as rekordbox stores it. */
  bitRate: number;
}

export interface ConversionFailure {
  file: string;
  error: string;
}

export interface ConversionResult {
  converted: ConvertedFile[];
  skipped: ConversionSkip[];
  failed: ConversionFailure[];
  cancelled: boolean;
}

export interface ConversionProgress {
  current: number;
  total: number;
  currentFile: string;
  converted: number;
  skipped: number;
  failed: number;
}

export interface AudioShape {
  sampleRate: number;
  bitsPerSample: number;
  channels: number;
  /** Sample frames; 0 when the file does not say. */
  samples: number;
}

export type CancelToken = { cancelled: boolean };

export const isFlacLocation = (location: string): boolean =>
  path.extname(location || '').toLowerCase() === '.flac';

/**
 * `Track.flac` becomes `Track.aiff` beside it — the folders do not change.
 *
 * Only the extension is replaced, never the path rebuilt: rekordbox on Windows
 * stores `C:/Users/…` with forward slashes, and `path.join` there would write
 * back `C:\Users\…`, a spelling of the path rekordbox itself never uses.
 */
export function convertedPath(location: string, format: ConversionFormat): string {
  const ext = path.extname(location);
  return `${location.slice(0, location.length - ext.length)}.${format}`;
}

/**
 * Decide what to convert. Entries that point at one file share one job, so the
 * file is converted once and every entry follows it. Paths are compared in NFC:
 * macOS keeps both spellings of an accent in the same library, and comparing
 * them raw would convert one file twice.
 *
 * A destination that already exists is never overwritten. It may be a
 * conversion made by hand, or a different recording with the same name —
 * there is no telling which, so it is reported and left alone.
 */
export function planConversions(
  tracks: ConvertibleTrack[],
  format: ConversionFormat,
  exists: (p: string) => boolean = fs.existsSync
): ConversionPlan {
  const jobs = new Map<string, ConversionJob>();
  const skipped: ConversionSkip[] = [];

  for (const track of tracks) {
    const location = (track.location || '').trim();
    if (!location || isStreamingLocation(location) || !isFlacLocation(location)) { continue; }

    const key = location.normalize('NFC');
    const existing = jobs.get(key);
    if (existing) { existing.trackIds.push(track.id); continue; }

    if (!exists(location)) {
      skipped.push({ trackId: track.id, location, kind: 'missing', reason: 'the file is not there' });
      continue;
    }
    const destination = convertedPath(location, format);
    if (exists(destination)) {
      skipped.push({
        trackId: track.id, location, kind: 'exists',
        reason: `${path.basename(destination)} is already there — it is left alone`,
      });
      continue;
    }
    jobs.set(key, { source: location, destination, trackIds: [track.id], size: track.size });
  }

  return { jobs: [...jobs.values()], skipped };
}

/** What the converted file will be: its encoder and the numbers the library stores. */
export interface OutputShape {
  codec: string;
  /** For MP3, the 16 bits a decoder produces; MP3 itself has no bit depth. */
  bits: number;
  sampleRate: number;
  /** kbps, the unit rekordbox stores: 44.1 kHz / 16-bit / stereo is 1411. */
  bitRate: number;
}

const MP3_SAMPLE_RATES = new Set([16000, 22050, 24000, 32000, 44100, 48000]);

/**
 * MP3 stops at 48 kHz. A high-resolution FLAC is resampled to the rate it is
 * a multiple of — 88.2 and 176.4 kHz to 44.1, 96 and 192 to 48 — which is the
 * cleanest conversion and keeps the family the recording was made in.
 */
export function mp3SampleRate(sampleRate: number): number {
  if (MP3_SAMPLE_RATES.has(sampleRate)) { return sampleRate; }
  return sampleRate % 44100 === 0 ? 44100 : 48000;
}

/** The encoder for a source: FLAC's 16 and 24 bits map straight across to PCM. */
export function outputShape(
  format: ConversionFormat,
  source: { sampleRate: number; bitsPerSample: number; channels: number }
): OutputShape {
  if (format === 'mp3') {
    return { codec: 'libmp3lame', bits: 16, sampleRate: mp3SampleRate(source.sampleRate), bitRate: MP3_BITRATE_KBPS };
  }
  const bits = source.bitsPerSample <= 16 ? 16 : source.bitsPerSample <= 24 ? 24 : 32;
  const endian = format === 'aiff' ? 'be' : 'le';
  return {
    codec: `pcm_s${bits}${endian}`,
    bits,
    sampleRate: source.sampleRate,
    bitRate: Math.round((source.sampleRate * bits * source.channels) / 1000),
  };
}

/**
 * The ffmpeg command line. Writes to `output` with an explicit format, since
 * the caller writes to a temporary name whose extension says nothing.
 *
 * AIFF and MP3 get the artwork and ID3v2.3, the version rekordbox and most
 * players read; MP3 an ID3v1 tag too, for the oldest players. WAV gets audio
 * and the RIFF INFO list only: ffmpeg's WAV writer cannot carry artwork.
 */
export function ffmpegArgs(
  source: string,
  output: string,
  format: ConversionFormat,
  shape: OutputShape,
  sourceSampleRate: number
): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n', '-i', source, '-map', '0:a:0'];
  if (format !== 'wav') {
    args.push('-map', '0:v:0?', '-c:v', 'copy', '-disposition:v', 'attached_pic', '-id3v2_version', '3');
  }
  if (format === 'aiff') { args.push('-write_id3v2', '1'); }
  args.push('-c:a', shape.codec);
  if (format === 'mp3') {
    // compression_level 0 is LAME's -q 0: the slowest, most careful search.
    args.push('-b:a', `${MP3_BITRATE_KBPS}k`, '-compression_level', '0', '-write_id3v1', '1');
    if (shape.sampleRate !== sourceSampleRate) { args.push('-ar', String(shape.sampleRate)); }
  }
  args.push('-map_metadata', '0', '-f', format, output);
  return args;
}

const PCM_SUBFORMAT_TAIL = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
]);

/**
 * Rewrite a WAVE_FORMAT_EXTENSIBLE header as plain PCM, in place.
 *
 * ffmpeg writes the extensible header for anything deeper than 16 bits or
 * faster than 48 kHz, and older CDJs refuse it as an unsupported format — the
 * very players this conversion exists for. For mono or stereo PCM the extra
 * fields say nothing a plain header does not, so the 40-byte `fmt ` body
 * becomes a 16-byte one followed by a 16-byte `JUNK` chunk, which every RIFF
 * reader skips. The two take exactly the space the old chunk did, so the
 * audio does not move and the file is patched without being rewritten.
 *
 * Returns whether anything changed. `header` must hold the start of the file
 * up to and including the `fmt ` chunk.
 */
export function toPlainPcmWavHeader(header: Buffer): boolean {
  if (header.length < 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
    return false;
  }
  let o = 12;
  while (o + 8 <= header.length) {
    const id = header.toString('ascii', o, o + 4);
    const size = header.readUInt32LE(o + 4);
    const body = o + 8;
    if (id === 'fmt ') {
      if (size !== 40 || body + 40 > header.length) { return false; }
      const tag = header.readUInt16LE(body);
      const channels = header.readUInt16LE(body + 2);
      const bits = header.readUInt16LE(body + 14);
      const validBits = header.readUInt16LE(body + 18);
      const subFormat = header.readUInt16LE(body + 24);
      const isPcm = subFormat === 1 && header.subarray(body + 26, body + 40).equals(PCM_SUBFORMAT_TAIL);
      if (tag !== 0xfffe || !isPcm || channels > 2 || validBits !== bits) { return false; }

      header.writeUInt32LE(16, o + 4);
      header.writeUInt16LE(1, body);
      const junk = body + 16;
      header.write('JUNK', junk, 'ascii');
      header.writeUInt32LE(16, junk + 4);
      header.fill(0, junk + 8, junk + 24);
      return true;
    }
    o = body + size + (size % 2);
  }
  return false;
}

function patchWavFile(file: string): void {
  const fd = fs.openSync(file, 'r+');
  try {
    const header = Buffer.alloc(4096);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    const head = header.subarray(0, read);
    if (toPlainPcmWavHeader(head)) { fs.writeSync(fd, head, 0, head.length, 0); }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * music-metadata's Node build, which reads a file by seeking rather than
 * loading it whole — a 24-bit AIFF runs to hundreds of megabytes. The
 * renderer's tsconfig also checks this file and resolves the package to its
 * browser build, which has no `parseFile`, hence the typed require.
 */
const { parseFile } = require('music-metadata') as {
  parseFile: (file: string, options?: IOptions) => Promise<IAudioMetadata>;
};

export async function probeAudio(file: string): Promise<AudioShape> {
  const { format } = await parseFile(file, { duration: true, skipCovers: true });
  const sampleRate = format.sampleRate ?? 0;
  // FLAC reports its length as a duration computed from the sample count, so
  // multiplying back gives the exact count; AIFF and WAV report it directly.
  const samples = format.numberOfSamples
    ?? (format.duration && sampleRate ? Math.round(format.duration * sampleRate) : 0);
  return {
    sampleRate,
    bitsPerSample: format.bitsPerSample ?? 16,
    channels: format.numberOfChannels ?? 0,
    samples,
  };
}

/** MP3 frames pad the end and the encoder delays the start; a tenth of a second covers both. */
const MP3_LENGTH_TOLERANCE_SECONDS = 0.1;

/**
 * Why a converted file cannot be trusted, or null when it can.
 *
 * For AIFF and WAV the sample count must match exactly: a file a few frames
 * short sounds fine, but it is not the recording that was converted. MP3
 * cannot match exactly, so its length is held to a tolerance instead — still
 * enough to catch a conversion that stopped partway.
 */
export function verifyConversion(
  source: AudioShape,
  output: AudioShape,
  expected: OutputShape,
  format: ConversionFormat
): string | null {
  if (output.sampleRate !== expected.sampleRate) {
    return `sample rate is ${output.sampleRate}, expected ${expected.sampleRate}`;
  }
  if (output.channels !== source.channels) {
    return `channel count changed (${source.channels} → ${output.channels})`;
  }
  if (output.samples <= 0) { return 'the converted file holds no audio'; }

  if (format === 'mp3') {
    if (source.samples > 0 && source.sampleRate > 0) {
      const before = source.samples / source.sampleRate;
      const after = output.samples / output.sampleRate;
      if (Math.abs(after - before) > MP3_LENGTH_TOLERANCE_SECONDS) {
        return `length changed (${before.toFixed(2)} s → ${after.toFixed(2)} s)`;
      }
    }
    return null;
  }

  if (output.bitsPerSample !== expected.bits) {
    return `bit depth is ${output.bitsPerSample}, expected ${expected.bits}`;
  }
  if (source.samples > 0 && output.samples !== source.samples) {
    return `length changed (${source.samples} → ${output.samples} samples)`;
  }
  return null;
}

export class FlacConverter {
  constructor(private readonly ffmpegPath: string) {}

  /**
   * Convert every job in turn. The original is never touched here: whether it
   * goes is decided only after the library points at the new file.
   *
   * Each file is written under a temporary name and renamed once it has been
   * checked, so a crash, a full disk or a cancel never leaves something with
   * the real name that is not a complete conversion.
   */
  async convert(
    plan: ConversionPlan,
    format: ConversionFormat,
    onProgress: (p: ConversionProgress) => void,
    cancelToken: CancelToken
  ): Promise<ConversionResult> {
    const result: ConversionResult = { converted: [], skipped: [...plan.skipped], failed: [], cancelled: false };
    const total = plan.jobs.length;

    for (let i = 0; i < total; i++) {
      if (cancelToken.cancelled) { result.cancelled = true; break; }
      const job = plan.jobs[i];
      onProgress({
        current: i + 1, total,
        currentFile: path.basename(job.source),
        converted: result.converted.length,
        skipped: result.skipped.length,
        failed: result.failed.length,
      });

      const temp = `${job.destination}.part`;
      try {
        // Checked again here: the plan may be minutes old by the time its turn comes.
        if (fs.existsSync(job.destination)) {
          for (const trackId of job.trackIds) {
            result.skipped.push({
              trackId, location: job.source, kind: 'exists',
              reason: `${path.basename(job.destination)} is already there — it is left alone`,
            });
          }
          continue;
        }

        const source = await probeAudio(job.source);
        const shape = outputShape(format, source);
        fs.rmSync(temp, { force: true });
        await this.run(ffmpegArgs(job.source, temp, format, shape, source.sampleRate), cancelToken);
        if (format === 'wav') { patchWavFile(temp); }

        const output = await probeAudio(temp);
        const problem = verifyConversion(source, output, shape, format);
        if (problem) { throw new Error(`the converted file failed its check: ${problem}`); }

        fs.renameSync(temp, job.destination);
        result.converted.push({
          trackIds: job.trackIds,
          oldLocation: job.source,
          newLocation: job.destination,
          format,
          size: fs.statSync(job.destination).size,
          sampleRate: shape.sampleRate,
          bitDepth: shape.bits,
          bitRate: shape.bitRate,
        });
      } catch (error) {
        fs.rmSync(temp, { force: true });
        if (cancelToken.cancelled) { result.cancelled = true; break; }
        result.failed.push({ file: job.source, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return result;
  }

  /** Run ffmpeg to completion, killing it as soon as the run is cancelled. */
  private run(args: string[], cancelToken: CancelToken): Promise<void> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      } catch (error) {
        reject(error);
        return;
      }
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
      const watch = setInterval(() => { if (cancelToken.cancelled) { child.kill(); } }, 200);
      child.on('error', (error) => { clearInterval(watch); reject(error); });
      child.on('close', (code) => {
        clearInterval(watch);
        if (cancelToken.cancelled) { reject(new Error('cancelled')); return; }
        if (code === 0) { resolve(); return; }
        reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with code ${code}`));
      });
    });
  }
}
