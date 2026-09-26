import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.unmock('fs');

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FlacConverter, planConversions, convertedPath, outputShape, mp3SampleRate, ffmpegArgs,
  toPlainPcmWavHeader, verifyConversion, probeAudio,
} from '../../src/main/flacConverter';
import { resolveFfmpegPath } from '../../src/main/ffmpegBinary';

describe('convertedPath', () => {
  it('puts the conversion beside the FLAC, under the same name', () => {
    expect(convertedPath('/music/A/Track.flac', 'aiff')).toBe('/music/A/Track.aiff');
    expect(convertedPath('/music/A/Track.FLAC', 'mp3')).toBe('/music/A/Track.mp3');
  });

  it('keeps the path spelled the way rekordbox stored it', () => {
    // rekordbox on Windows writes forward slashes; rebuilding the path would not.
    expect(convertedPath('C:/Users/dj/Songs/01 - A.b (edit).flac', 'aiff')).toBe('C:/Users/dj/Songs/01 - A.b (edit).aiff');
  });
});

describe('planConversions', () => {
  const all = () => true;

  it('converts a file once for every entry that points at it', () => {
    // macOS keeps both spellings of an accent; they are one file.
    const nfc = '/m/Café.flac';
    const nfd = nfc.normalize('NFD');
    const plan = planConversions(
      [{ id: '1', location: nfc }, { id: '2', location: nfd }],
      'aiff',
      (p) => p.endsWith('.flac')
    );
    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0].trackIds).toEqual(['1', '2']);
  });

  it('ignores what is not FLAC, and streaming tracks', () => {
    const plan = planConversions([
      { id: '1', location: '/m/a.mp3' },
      { id: '2', location: 'tidal:tracks:123' },
      { id: '3', location: '' },
    ], 'aiff', all);
    expect(plan.jobs).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it('reports a FLAC whose file is gone', () => {
    const plan = planConversions([{ id: '1', location: '/m/a.flac' }], 'aiff', () => false);
    expect(plan.skipped[0]).toMatchObject({ trackId: '1', kind: 'missing' });
  });

  it('never overwrites a file already at the destination', () => {
    // It may be a hand-made conversion or a different recording with the same name.
    const plan = planConversions([{ id: '1', location: '/m/a.flac' }], 'wav', all);
    expect(plan.jobs).toEqual([]);
    expect(plan.skipped[0]).toMatchObject({ trackId: '1', kind: 'exists' });
  });
});

describe('outputShape', () => {
  it('keeps the bit depth and rate of a lossless conversion', () => {
    expect(outputShape('aiff', { sampleRate: 44100, bitsPerSample: 16, channels: 2 }))
      .toEqual({ codec: 'pcm_s16be', bits: 16, sampleRate: 44100, bitRate: 1411 });
    expect(outputShape('wav', { sampleRate: 96000, bitsPerSample: 24, channels: 2 }))
      .toMatchObject({ codec: 'pcm_s24le', bits: 24, sampleRate: 96000 });
  });

  it('makes MP3 320 kbps constant bit rate', () => {
    expect(outputShape('mp3', { sampleRate: 44100, bitsPerSample: 24, channels: 2 }))
      .toMatchObject({ codec: 'libmp3lame', bitRate: 320, sampleRate: 44100 });
  });
});

describe('mp3SampleRate', () => {
  it('resamples high-resolution audio to the family it came from', () => {
    expect(mp3SampleRate(44100)).toBe(44100);
    expect(mp3SampleRate(48000)).toBe(48000);
    expect(mp3SampleRate(88200)).toBe(44100);
    expect(mp3SampleRate(176400)).toBe(44100);
    expect(mp3SampleRate(96000)).toBe(48000);
    expect(mp3SampleRate(192000)).toBe(48000);
  });
});

describe('ffmpegArgs', () => {
  const shape = (format: 'aiff' | 'wav' | 'mp3', sampleRate = 44100) =>
    outputShape(format, { sampleRate, bitsPerSample: 16, channels: 2 });

  it('never lets ffmpeg overwrite anything', () => {
    expect(ffmpegArgs('in.flac', 'out.part', 'aiff', shape('aiff'), 44100)).toContain('-n');
  });

  it('carries artwork into AIFF and MP3 but not WAV', () => {
    expect(ffmpegArgs('in.flac', 'o', 'aiff', shape('aiff'), 44100)).toContain('0:v:0?');
    expect(ffmpegArgs('in.flac', 'o', 'mp3', shape('mp3'), 44100)).toContain('0:v:0?');
    expect(ffmpegArgs('in.flac', 'o', 'wav', shape('wav'), 44100)).not.toContain('0:v:0?');
  });

  it('resamples MP3 only when it has to', () => {
    expect(ffmpegArgs('in.flac', 'o', 'mp3', shape('mp3', 44100), 44100)).not.toContain('-ar');
    const args = ffmpegArgs('in.flac', 'o', 'mp3', shape('mp3', 96000), 96000);
    expect(args[args.indexOf('-ar') + 1]).toBe('48000');
  });
});

/** The header ffmpeg writes for 24-bit stereo WAV. */
function extensibleHeader(channels = 2, bits = 24, validBits = bits): Buffer {
  const b = Buffer.alloc(12 + 8 + 40 + 8);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(1000, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(40, 16);
  const f = 20;
  b.writeUInt16LE(0xfffe, f); b.writeUInt16LE(channels, f + 2); b.writeUInt32LE(48000, f + 4);
  b.writeUInt32LE(48000 * channels * 3, f + 8); b.writeUInt16LE(channels * 3, f + 12);
  b.writeUInt16LE(bits, f + 14); b.writeUInt16LE(22, f + 16); b.writeUInt16LE(validBits, f + 18);
  b.writeUInt32LE(3, f + 20); b.writeUInt16LE(1, f + 24);
  Buffer.from([0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]).copy(b, f + 26);
  b.write('data', f + 40, 'ascii');
  return b;
}

describe('toPlainPcmWavHeader', () => {
  it('rewrites an extensible PCM header as plain PCM without moving the audio', () => {
    const header = extensibleHeader();
    expect(toPlainPcmWavHeader(header)).toBe(true);
    expect(header.readUInt32LE(16)).toBe(16);         // fmt is 16 bytes now
    expect(header.readUInt16LE(20)).toBe(1);          // WAVE_FORMAT_PCM
    expect(header.readUInt16LE(22)).toBe(2);          // channels untouched
    expect(header.readUInt16LE(34)).toBe(24);         // bits untouched
    expect(header.toString('ascii', 36, 40)).toBe('JUNK');
    expect(header.readUInt32LE(40)).toBe(16);
    expect(header.toString('ascii', 60, 64)).toBe('data'); // where it was
  });

  it('leaves a surround file alone — its channel mask matters', () => {
    expect(toPlainPcmWavHeader(extensibleHeader(6))).toBe(false);
  });

  it('leaves a header whose valid bits differ from the container alone', () => {
    expect(toPlainPcmWavHeader(extensibleHeader(2, 32, 24))).toBe(false);
  });

  it('leaves a plain header alone', () => {
    const header = extensibleHeader();
    toPlainPcmWavHeader(header);
    expect(toPlainPcmWavHeader(header)).toBe(false);
  });
});

describe('verifyConversion', () => {
  const source = { sampleRate: 44100, bitsPerSample: 16, channels: 2, samples: 441000 };
  const pcm = outputShape('aiff', source);
  const mp3 = outputShape('mp3', source);

  it('accepts an exact lossless conversion', () => {
    expect(verifyConversion(source, { ...source }, pcm, 'aiff')).toBeNull();
  });

  it('refuses a lossless conversion one frame short', () => {
    expect(verifyConversion(source, { ...source, samples: 440999 }, pcm, 'aiff')).toMatch(/length/);
  });

  it('refuses a file with no audio', () => {
    expect(verifyConversion(source, { ...source, samples: 0 }, pcm, 'wav')).toMatch(/no audio/);
  });

  it('allows MP3 its encoder padding, but not a conversion that stopped partway', () => {
    expect(verifyConversion(source, { ...source, samples: 441000 + 1105 + 1152 }, mp3, 'mp3')).toBeNull();
    expect(verifyConversion(source, { ...source, samples: 220500 }, mp3, 'mp3')).toMatch(/length/);
  });
});

// ─── The real thing, with the bundled ffmpeg ─────────────────────────────────

const ffmpeg = resolveFfmpegPath({
  isPackaged: false,
  resourcesPath: '',
  appPath: path.resolve(__dirname, '../..'),
  platform: process.platform,
  arch: process.arch,
});

describe.skipIf(!ffmpeg)('FlacConverter with the bundled ffmpeg', () => {
  let dir: string;
  let flac: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flacconv-'));
    const audio = path.join(dir, 'audio.flac');
    const cover = path.join(dir, 'cover.jpg');
    flac = path.join(dir, 'Tést Track.flac');
    const run = (args: string[]) => execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=96000', '-ac', '2',
      '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', audio]);
    run(['-f', 'lavfi', '-i', 'color=red:s=32x32:d=1', '-frames:v', '1', cover]);
    run(['-i', audio, '-i', cover, '-map', '0:a', '-map', '1:v', '-c', 'copy',
      '-disposition:v', 'attached_pic', '-metadata', 'title=Tést Track', '-metadata', 'artist=Someone', flac]);
  });

  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const convert = async (format: 'aiff' | 'wav' | 'mp3') => {
    const plan = planConversions([{ id: 't1', location: flac }], format);
    return new FlacConverter(ffmpeg!).convert(plan, format, () => {}, { cancelled: false });
  };

  it('writes a sample-exact 24-bit AIFF and leaves the FLAC alone', async () => {
    const before = fs.readFileSync(flac);
    const result = await convert('aiff');
    expect(result.failed).toEqual([]);
    const [file] = result.converted;
    expect(file).toMatchObject({ format: 'aiff', bitDepth: 24, sampleRate: 96000, trackIds: ['t1'] });

    const [src, out] = await Promise.all([probeAudio(flac), probeAudio(file.newLocation)]);
    expect(out.samples).toBe(src.samples);
    expect(fs.readFileSync(flac).equals(before)).toBe(true);
    expect(fs.existsSync(`${file.newLocation}.part`)).toBe(false);
  });

  it('writes a WAV with a plain PCM header, which older CDJs accept', async () => {
    const result = await convert('wav');
    expect(result.failed).toEqual([]);
    const head = fs.readFileSync(result.converted[0].newLocation).subarray(0, 24);
    expect(head.readUInt16LE(20)).toBe(1);
  });

  it('writes a 320 kbps MP3, resampled from 96 to 48 kHz', async () => {
    const result = await convert('mp3');
    expect(result.failed).toEqual([]);
    expect(result.converted[0]).toMatchObject({ format: 'mp3', bitRate: 320, sampleRate: 48000 });
    const out = await probeAudio(result.converted[0].newLocation);
    expect(out.sampleRate).toBe(48000);
  });

  it('skips a destination that appeared after the plan was made', async () => {
    const plan = planConversions([{ id: 't1', location: flac }], 'aiff', (p) => p === flac);
    const result = await new FlacConverter(ffmpeg!).convert(plan, 'aiff', () => {}, { cancelled: false });
    expect(result.converted).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ kind: 'exists' });
  });

  it('stops without leaving a partial file when cancelled', async () => {
    const plan = planConversions([{ id: 't1', location: flac }], 'aiff', (p) => p === flac);
    plan.jobs[0].destination = path.join(dir, 'cancelled.aiff');
    const result = await new FlacConverter(ffmpeg!).convert(plan, 'aiff', () => {}, { cancelled: true });
    expect(result.cancelled).toBe(true);
    expect(fs.existsSync(path.join(dir, 'cancelled.aiff'))).toBe(false);
  });
});
