import { describe, it, expect } from 'vitest';
import { writePlansFor, settleConversions, applyConversionsToLibrary, locationsStillUsed } from '../../src/main/conversionSettlement';
import { resolveFfmpegPath } from '../../src/main/ffmpegBinary';
import type { ConvertedFile } from '../../src/main/flacConverter';

const file = (trackIds: string[], name = 'Song'): ConvertedFile => ({
  trackIds, oldLocation: `/m/${name}.flac`, newLocation: `/m/${name}.aiff`, format: 'aiff',
  size: 100, sampleRate: 44100, bitDepth: 16, bitRate: 1411,
});

describe('writePlansFor', () => {
  it('writes every entry that pointed at a converted file', () => {
    const plans = writePlansFor([file(['a', 'b'])]);
    expect(plans.map((p) => p.trackId)).toEqual(['a', 'b']);
    expect(plans[1]).toMatchObject({ oldLocation: '/m/Song.flac', newLocation: '/m/Song.aiff' });
  });
});

describe('settleConversions', () => {
  it('trashes an original only when every entry has left it', () => {
    const s = settleConversions([file(['a', 'b'])], new Set(['a', 'b']));
    expect(s.trashable).toEqual(['/m/Song.flac']);
    expect(s.orphaned).toEqual([]);
  });

  it('keeps the original while one entry still points at it', () => {
    const s = settleConversions([file(['a', 'b'])], new Set(['a']));
    expect(s.kept).toHaveLength(1);
    expect(s.trashable).toEqual([]);
  });

  it('keeps a FLAC that an entry outside the converted playlist still uses', () => {
    // Converting one playlist must not trash a file another entry depends on.
    const all = [
      { id: 'a', location: '/m/Song.flac' },
      { id: 'outside', location: '/m/Song.flac'.normalize('NFD') },
    ];
    const updated = new Set(['a']);
    const s = settleConversions([file(['a'])], updated, locationsStillUsed(all, updated));
    expect(s.kept).toHaveLength(1);
    expect(s.trashable).toEqual([]);
  });

  it('trashes it when nothing outside the playlist uses it', () => {
    const all = [{ id: 'a', location: '/m/Song.flac' }, { id: 'b', location: '/m/Other.flac' }];
    const updated = new Set(['a']);
    expect(settleConversions([file(['a'])], updated, locationsStillUsed(all, updated)).trashable).toEqual(['/m/Song.flac']);
  });

  it('removes a conversion nothing points at', () => {
    const s = settleConversions([file(['a'])], new Set());
    expect(s.orphaned).toEqual(['/m/Song.aiff']);
    expect(s.kept).toEqual([]);
    expect(s.trashable).toEqual([]);
  });
});

describe('applyConversionsToLibrary', () => {
  it('re-points the XML entry and describes the new file', () => {
    const tracks = new Map([['a', { location: '/m/Song.flac', kind: 'FLAC File', size: 1 }]]);
    const out = applyConversionsToLibrary(tracks, writePlansFor([file(['a'])]));
    expect(out.tracksUpdated).toBe(1);
    expect(tracks.get('a')).toMatchObject({ location: '/m/Song.aiff', kind: 'AIFF File', size: 100, bitrate: 1411 });
  });

  it('leaves an entry that points elsewhere now', () => {
    const tracks = new Map([['a', { location: '/other/Song.flac' }]]);
    const out = applyConversionsToLibrary(tracks, writePlansFor([file(['a'])]));
    expect(out.tracksUpdated).toBe(0);
    expect(tracks.get('a')!.location).toBe('/other/Song.flac');
  });
});

describe('resolveFfmpegPath', () => {
  const base = { resourcesPath: '/app/resources', appPath: '/repo', platform: 'darwin' as const, arch: 'arm64' };

  it('reads the packaged copy from resources', () => {
    expect(resolveFfmpegPath({ ...base, isPackaged: true, exists: () => true }))
      .toBe(require('path').join('/app/resources', 'ffmpeg', 'ffmpeg'));
  });

  it('reads the fetched copy in development, per platform and arch', () => {
    expect(resolveFfmpegPath({ ...base, isPackaged: false, exists: () => true }))
      .toBe(require('path').join('/repo', 'vendor', 'ffmpeg', 'darwin-arm64', 'ffmpeg'));
  });

  it('says there is none rather than guessing', () => {
    expect(resolveFfmpegPath({ ...base, isPackaged: true, exists: () => false })).toBeNull();
  });
});
