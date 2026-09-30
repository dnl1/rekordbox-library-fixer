import { describe, it, expect, vi } from 'vitest';
vi.unmock('crypto');

import * as crypto from 'crypto';
import { authQuery, createSubsonicClient, normalizeServerUrl, toSong, SubsonicError } from '../../src/main/navidrome/subsonic';

const conn = { url: 'https://music.example.com', username: 'dj', password: 'sesame' };

const reply = (body: Record<string, unknown>, status = 'ok') =>
  new Response(JSON.stringify({ 'subsonic-response': { status, version: '1.16.1', ...body } }), { status: 200 });

/** A fetch that answers from a table of endpoints, and records every URL it was asked for. */
function fakeFetch(answers: Record<string, () => Response | Promise<Response>>) {
  const urls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    urls.push(url);
    const endpoint = new URL(url).pathname.split('/').pop() as string;
    const answer = answers[endpoint];
    if (!answer) { return new Response('not found', { status: 404 }); }
    return answer();
  });
  return { impl, urls };
}

describe('normalizeServerUrl', () => {
  it('keeps the scheme, host and path prefix, without a trailing slash', () => {
    expect(normalizeServerUrl(' https://music.example.com/ ')).toBe('https://music.example.com');
    expect(normalizeServerUrl('http://192.168.5.154:4533/navidrome/')).toBe('http://192.168.5.154:4533/navidrome');
  });

  it('asks for the scheme rather than guessing one', () => {
    expect(() => normalizeServerUrl('music.example.com')).toThrow(/http:\/\/ or https:\/\//);
  });

  it('refuses a query or fragment, which the requests would drop', () => {
    expect(() => normalizeServerUrl('https://music.example.com/?u=dj')).toThrow(/without anything after/);
  });
});

describe('authQuery', () => {
  it('sends a salted token instead of the password', () => {
    const q = authQuery(conn, 'abc123');
    expect(q.get('u')).toBe('dj');
    expect(q.get('s')).toBe('abc123');
    expect(q.get('t')).toBe(crypto.createHash('md5').update('sesameabc123').digest('hex'));
    expect(q.get('f')).toBe('json');
    expect(q.toString()).not.toContain('sesame');
  });

  it('uses a fresh salt each time', () => {
    expect(authQuery(conn).get('s')).not.toBe(authQuery(conn).get('s'));
  });
});

describe('createSubsonicClient', () => {
  it('pings the server and reports its version', async () => {
    const { impl, urls } = fakeFetch({ 'ping.view': () => reply({ type: 'navidrome', serverVersion: '0.53.3' }) });
    const info = await createSubsonicClient(conn, impl).ping();
    expect(info).toEqual({ apiVersion: '1.16.1', type: 'navidrome', serverVersion: '0.53.3' });
    expect(urls[0]).toMatch(/^https:\/\/music\.example\.com\/rest\/ping\.view\?/);
    expect(urls[0]).not.toContain('sesame');
  });

  it('says the credentials are wrong in words, not as error 40', async () => {
    const { impl } = fakeFetch({ 'ping.view': () => reply({ error: { code: 40, message: 'Wrong username or password' } }, 'failed') });
    await expect(createSubsonicClient(conn, impl).ping()).rejects.toMatchObject({ code: 40, message: 'Wrong username or password.' });
  });

  it('explains an address that is not a Navidrome server', async () => {
    const html = fakeFetch({ 'ping.view': () => new Response('<html>', { status: 200 }) });
    await expect(createSubsonicClient(conn, html.impl).ping()).rejects.toThrow(/did not answer like a Navidrome server/);
    const missing = fakeFetch({});
    await expect(createSubsonicClient(conn, missing.impl).ping()).rejects.toThrow(/HTTP 404/);
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(createSubsonicClient(conn, down).ping()).rejects.toThrow(/Could not reach https:\/\/music\.example\.com — ECONNREFUSED/);
  });

  it('lists playlists, including a server that sends a single one as an object', async () => {
    const { impl } = fakeFetch({
      'getPlaylists.view': () => reply({ playlists: { playlist: { id: 'p1', name: 'Warm up', songCount: 12, duration: 3600 } } }),
    });
    expect(await createSubsonicClient(conn, impl).playlists()).toEqual([
      { id: 'p1', name: 'Warm up', songCount: 12, duration: 3600, owner: undefined },
    ]);
  });

  it('reads a playlist in its order, and a song by id', async () => {
    const { impl, urls } = fakeFetch({
      'getPlaylist.view': () => reply({ playlist: { name: 'Peak', entry: [{ id: 's2', title: 'B', suffix: 'MP3' }, { id: 's1', title: 'A', suffix: 'flac' }] } }),
      'getSong.view': () => reply({ song: { id: 's9', title: 'Solo', suffix: 'aiff', size: 100 } }),
    });
    const client = createSubsonicClient(conn, impl);
    const playlist = await client.playlist('p1');
    expect(playlist.name).toBe('Peak');
    expect(playlist.songs.map((s) => [s.id, s.suffix])).toEqual([['s2', 'mp3'], ['s1', 'flac']]);
    expect((await client.song('s9')).title).toBe('Solo');
    expect(new URL(urls[1]).searchParams.get('id')).toBe('s9');
  });

  it('searches songs only', async () => {
    const { impl, urls } = fakeFetch({ 'search3.view': () => reply({ searchResult3: { song: [{ id: 's1', title: 'Hit', suffix: 'mp3' }] } }) });
    expect((await createSubsonicClient(conn, impl).searchSongs('hit')).map((s) => s.id)).toEqual(['s1']);
    const q = new URL(urls[0]).searchParams;
    expect([q.get('query'), q.get('artistCount'), q.get('albumCount')]).toEqual(['hit', '0', '0']);
  });

  it('downloads the original file, not a transcode', () => {
    const url = new URL(createSubsonicClient(conn, vi.fn()).downloadUrl('s1'));
    expect(url.pathname).toBe('/rest/download.view');
    expect(url.searchParams.get('id')).toBe('s1');
  });

  it('refuses to start without a username', () => {
    expect(() => createSubsonicClient({ ...conn, username: '' })).toThrow(SubsonicError);
  });
});

describe('toSong', () => {
  it('narrows what the server sent, and skips folders', () => {
    expect(toSong({ id: 1, title: 'T', duration: '300', suffix: 'MP3', year: 2020 })).toMatchObject({ id: '1', duration: undefined, suffix: 'mp3', year: 2020 });
    expect(toSong({ id: 'd', isDir: true })).toBeNull();
    expect(toSong(null)).toBeNull();
  });
});
