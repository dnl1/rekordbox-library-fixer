import { describe, it, expect } from 'vitest';
import { playlistScopes } from '../../src/renderer/utils/playlistScopes';

const pl = (name: string, tracks: string[]) => ({ name, type: 'PLAYLIST' as const, tracks });
const folder = (name: string, children: any[]) => ({ name, type: 'FOLDER' as const, tracks: [], children });

describe('playlistScopes', () => {
  it('lists playlists by their folder path, parents first', () => {
    const scopes = playlistScopes([folder('Gigs', [pl('Friday', ['1', '2']), pl('Saturday', ['2', '3'])]), pl('Warmup', ['4'])]);
    expect(scopes.map((s) => s.label)).toEqual(['Gigs', 'Gigs / Friday', 'Gigs / Saturday', 'Warmup']);
  });

  it('gives a folder every track beneath it, once', () => {
    const [gigs] = playlistScopes([folder('Gigs', [pl('Friday', ['1', '2']), pl('Saturday', ['2', '3'])])]);
    expect(gigs).toMatchObject({ isFolder: true, trackIds: ['1', '2', '3'] });
  });

  it('counts a track listed twice in a playlist once', () => {
    expect(playlistScopes([pl('Set', ['1', '1', '2'])])[0].trackIds).toEqual(['1', '2']);
  });

  it('tells two playlists with the same name apart', () => {
    const scopes = playlistScopes([folder('A', [pl('Set', ['1'])]), folder('B', [pl('Set', ['2'])])]);
    const sets = scopes.filter((s) => s.label.endsWith('Set'));
    expect(sets.map((s) => s.label)).toEqual(['A / Set', 'B / Set']);
    expect(new Set(sets.map((s) => s.key)).size).toBe(2);
  });

  it('keeps two playlists of the same name in one folder apart', () => {
    // rekordbox allows it; a key made of names picked the first whichever was chosen.
    const scopes = playlistScopes([folder('Gigs', [pl('Friday', ['1']), pl('Friday', ['2'])])]);
    const fridays = scopes.filter((s) => s.label === 'Gigs / Friday');
    expect(fridays.map((s) => s.trackIds)).toEqual([['1'], ['2']]);
    expect(new Set(fridays.map((s) => s.key)).size).toBe(2);
  });

  it('leaves out what is empty', () => {
    expect(playlistScopes([pl('Empty', []), folder('Nothing', [pl('Empty too', [])])])).toEqual([]);
  });
});
