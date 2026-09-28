import { describe, it, expect } from 'vitest';
import { trackDifferences, formatOf } from '../../src/renderer/utils/trackDifferences';
import { describeMatch } from '../../src/main/duplicateMatch';

const aiff = {
  id: 'a', name: 'Takata (Extended Mix)', artist: 'The Rocketman', location: '/Music/Takata.aiff',
  duration: 351, bitrate: 1411, size: 61_000_000, sampleRate: 44100, bitDepth: 16, bpm: 128, cues: [1, 2],
};

describe('trackDifferences', () => {
  it('never counts the path as a difference', () => {
    const copy = { ...aiff, id: 'b', location: '/Beatport Top 100/The Rocketman - Takata.aiff' };
    expect(trackDifferences([aiff, copy])).toEqual([]);
  });

  it('lists what differs, with each copy’s value, most telling first', () => {
    const wav = { ...aiff, id: 'b', location: '/UnknownAlbum/Takata.wav', size: 60_000_000, bitDepth: 24, cues: [] };
    const diff = trackDifferences([aiff, wav]);
    expect(diff.map((d) => d.label)).toEqual(['Format', 'Bit depth', 'Size', 'Cues']);
    expect(diff[0].values).toEqual({ a: 'AIFF', b: 'WAV' });
    expect(diff[3].values).toEqual({ a: '2', b: '0' });
  });

  it('tells two sizes apart even when they read alike rounded', () => {
    const copy = { ...aiff, id: 'b', size: aiff.size + 1200 };
    expect(trackDifferences([aiff, copy]).map((d) => d.field)).toEqual(['size']);
  });

  it('treats a value only one copy has as a difference', () => {
    const mp3 = { ...aiff, id: 'b', location: '/m/Takata.mp3', bitrate: 320, sampleRate: undefined, bitDepth: undefined };
    const diff = trackDifferences([aiff, mp3]);
    expect(diff.find((d) => d.field === 'bitDepth')?.values).toEqual({ a: '16-bit', b: '—' });
  });

  it('reads the format from the extension, AIF as AIFF', () => {
    expect(formatOf({ id: 'x', location: '/m/a.aif' })).toBe('AIFF');
    expect(formatOf({ id: 'x', location: 'tidal:tracks:1', kind: 'Streaming' })).toBe('Streaming');
  });
});

describe('describeMatch', () => {
  it('calls the byte comparison what it is — identical files — not a fingerprint', () => {
    expect(describeMatch({ matchType: 'fingerprint' })).toEqual({
      method: 'Identical files',
      detail: 'Same file size, length, bitrate and first 1 MB of the file — copies of one file',
    });
  });

  it('says a metadata match is only that, naming the fields', () => {
    expect(describeMatch({ matchType: 'metadata', matchedOn: ['artist', 'title', 'duration'] })).toEqual({
      method: 'Metadata',
      detail: 'Same artist, title and length — the files themselves may differ',
    });
  });

  it('says when the files could not be read at all', () => {
    expect(describeMatch({ matchType: 'metadata', filesMissing: true }).method).toBe('Metadata · files unreadable');
  });
});
