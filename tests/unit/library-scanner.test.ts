import { describe, it, expect } from 'vitest';
import { databaseCandidates, xmlSearchDirs } from '../../src/main/libraryScanner';

describe('databaseCandidates', () => {
  it('looks in the unversioned directory first, as rekordbox 7 uses it', () => {
    const paths = databaseCandidates('/Users/dj', 'darwin');
    expect(paths[0]).toBe('/Users/dj/Library/Pioneer/rekordbox/master.db');
    expect(paths).toHaveLength(3);
  });

  it('uses the Pioneer directory under APPDATA on Windows, not the home folder', () => {
    // Callers pass the home folder; the database was looked for in <home>\Pioneer
    // and so never listed on Windows.
    const paths = databaseCandidates('C:\\Users\\dj', 'win32', 'C:\\Users\\dj\\AppData\\Roaming');
    expect(paths[0]).toBe('C:\\Users\\dj\\AppData\\Roaming\\Pioneer\\rekordbox\\master.db');
  });

  it('falls back to AppData\\Roaming under the home folder when APPDATA is unset', () => {
    const paths = databaseCandidates('C:\\Users\\dj', 'win32', undefined);
    expect(paths[0]).toBe('C:\\Users\\dj\\AppData\\Roaming\\Pioneer\\rekordbox\\master.db');
  });
});

describe('xmlSearchDirs', () => {
  it('includes the places people actually export to', () => {
    const dirs = xmlSearchDirs('/Users/dj');
    expect(dirs).toContain('/Users/dj/Documents/rekordbox');
    expect(dirs).toContain('/Users/dj/Desktop');
    expect(dirs).toContain('/Users/dj/Downloads');
  });

  it('checks the rekordbox folder before the wider Documents folder', () => {
    const dirs = xmlSearchDirs('/Users/dj');
    expect(dirs.indexOf('/Users/dj/Documents/rekordbox')).toBeLessThan(dirs.indexOf('/Users/dj/Documents'));
  });
});
