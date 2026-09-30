import { describe, it, expect } from 'vitest';
import { CONSOLIDATE_FOLDER_NAME, defaultConsolidateDestination } from '../../src/main/defaultPaths';

describe('defaultConsolidateDestination', () => {
  it('is a folder of its own in the Music folder on macOS', () => {
    expect(defaultConsolidateDestination('/Users/dj/Music', 'darwin')).toBe('/Users/dj/Music/Rekordbox Library');
  });

  it('is written the Windows way on Windows', () => {
    expect(defaultConsolidateDestination('C:\\Users\\dj\\Music', 'win32')).toBe('C:\\Users\\dj\\Music\\Rekordbox Library');
  });

  it('follows the Music folder Linux reports, wherever it is', () => {
    expect(defaultConsolidateDestination('/home/dj/Musik', 'linux')).toBe('/home/dj/Musik/Rekordbox Library');
  });

  it('is never the Music folder itself', () => {
    // Resolving duplicates keeps the copy inside this folder, and nearly every track is inside Music.
    const music = '/Users/dj/Music';
    expect(defaultConsolidateDestination(music, 'darwin')).not.toBe(music);
    expect(CONSOLIDATE_FOLDER_NAME).toBeTruthy();
  });
});
