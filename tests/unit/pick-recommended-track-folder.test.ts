import { describe, it, expect } from 'vitest';
import { pickRecommendedTrack, isInsideFolder } from '../../src/renderer/utils/pickRecommendedTrack';

const flacOutside = { id: 'a', location: '/Users/dj/Downloads/Song.flac', bitrate: 1411, size: 40_000_000 };
const mp3Inside = { id: 'b', location: '/Volumes/SSD/Music/Artist/Song.mp3', bitrate: 320, size: 9_000_000 };
const wavInside = { id: 'c', location: '/Volumes/SSD/Music/Song.wav', bitrate: 1411, size: 50_000_000 };

describe('pickRecommendedTrack with the consolidate folder', () => {
  it('keeps the copy inside the folder even when one outside scores higher', () => {
    const keeper = pickRecommendedTrack([flacOutside, mp3Inside], 'keep-highest-quality', [], true, '/Volumes/SSD/Music');
    expect(keeper.id).toBe('b');
  });

  it('lets the strategy decide among the copies inside the folder', () => {
    const keeper = pickRecommendedTrack([flacOutside, mp3Inside, wavInside], 'keep-highest-quality', [], false, '/Volumes/SSD/Music/');
    expect(keeper.id).toBe('c');
  });

  it('falls back to the strategy when no copy, or every copy, is inside', () => {
    expect(pickRecommendedTrack([flacOutside, mp3Inside], 'keep-highest-quality', [], true, '').id).toBe('a');
    expect(pickRecommendedTrack([flacOutside, mp3Inside], 'keep-highest-quality', [], true, '/Elsewhere').id).toBe('a');
    expect(pickRecommendedTrack([mp3Inside, wavInside], 'keep-highest-quality', [], false, '/Volumes/SSD').id).toBe('c');
  });

  it('still leaves the choice to the user under the manual strategy', () => {
    expect(pickRecommendedTrack([flacOutside, mp3Inside], 'manual', [], false, '/Volumes/SSD/Music')).toBeNull();
  });
});

describe('isInsideFolder', () => {
  it('matches whole folder names, not prefixes of them', () => {
    expect(isInsideFolder('/Volumes/SSD/Music2/Song.mp3', '/Volumes/SSD/Music')).toBe(false);
    expect(isInsideFolder('/Volumes/SSD/Music/Song.mp3', '/Volumes/SSD/Music')).toBe(true);
  });

  it('ignores case, accent encoding and slash direction', () => {
    expect(isInsideFolder('/volumes/ssd/Músic/Song.mp3', '/Volumes/SSD/Mu\u0301sic')).toBe(true);
    expect(isInsideFolder('D:\\Music\\Song.mp3', 'D:/Music')).toBe(true);
  });
});

describe('pickRecommendedTrack quality tiers', () => {
  const wav = { id: 'w', location: '/Music/Song.wav', bitrate: 2304, size: 60_000_000 };
  const aiff = { id: 'a', location: '/Music/Song.aiff', bitrate: 1411, size: 50_000_000 };
  const aif = { id: 'b', location: '/Music/Song.AIF', bitrate: 1411, size: 50_000_000 };
  const flac = { id: 'f', location: '/Music/Song.flac', bitrate: 1411, size: 30_000_000 };
  const mp3 = { id: 'm', location: '/Music/Song.mp3', bitrate: 320, size: 9_000_000 };

  it('keeps the AIFF over a WAV, even a bigger one', () => {
    expect(pickRecommendedTrack([wav, aiff], 'keep-highest-quality').id).toBe('a');
    expect(pickRecommendedTrack([wav, aif], 'keep-highest-quality').id).toBe('b');
  });

  it('keeps the AIFF over a FLAC the user prefers', () => {
    expect(pickRecommendedTrack([flac, aiff], 'keep-highest-quality', [], true).id).toBe('a');
  });

  it('still puts WAV above lossy, and FLAC above lossy only when preferred', () => {
    expect(pickRecommendedTrack([mp3, wav], 'keep-highest-quality').id).toBe('w');
    expect(pickRecommendedTrack([mp3, flac], 'keep-highest-quality', [], false).id).toBe('f'); // bitrate decides
    expect(pickRecommendedTrack([wav, flac], 'keep-highest-quality', [], true).id).toBe('w'); // same tier, size decides
  });
});
