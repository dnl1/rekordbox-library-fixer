import { describe, it, expect, vi, afterEach } from 'vitest';
vi.unmock('fs');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RekordboxParser } from '../../src/main/rekordboxParser';

/**
 * rekordbox writes a mark's Type as a number (0 cue, 1 fade-in, 2 fade-out,
 * 3 load, 4 loop) and its Num as -1 for a memory cue or 0, 1, 2… for hot cue
 * A, B, C. The parser looked for the words "CUE" and "LOOP", so every cue and
 * loop in a real export was dropped and every XML the app saved lost them all.
 */
const xml = (marks: string) => `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.2.14" Company="AlphaTheta"/>
  <COLLECTION Entries="1">
    <TRACK TrackID="1" Name="Song" Artist="A" Kind="FLAC File" Location="file://localhost/m/Song.flac">
      <TEMPO Inizio="0.025" Bpm="128.00" Metro="4/4" Battito="1"/>
${marks}
    </TRACK>
  </COLLECTION>
  <PLAYLISTS><NODE Type="0" Name="ROOT" Count="0"/></PLAYLISTS>
</DJ_PLAYLISTS>
`;

const REAL_MARKS = `      <POSITION_MARK Name="" Type="0" Start="0.647" Num="-1"/>
      <POSITION_MARK Name="Drop" Type="0" Start="7.078" Num="2" Red="60" Green="235" Blue="80"/>
      <POSITION_MARK Name="" Type="4" Start="174.911" End="178.339" Num="-1"/>
      <POSITION_MARK Name="" Type="4" Start="16.0" End="20.0" Num="0" Red="255" Green="140" Blue="0"/>`;

const files: string[] = [];
const write = (content: string) => {
  const file = path.join(os.tmpdir(), `marks-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`);
  fs.writeFileSync(file, content);
  files.push(file);
  return file;
};
afterEach(() => { for (const f of files.splice(0)) { fs.rmSync(f, { force: true }); } });

const parser = () => new RekordboxParser();

describe('POSITION_MARK', () => {
  it('reads the cues and loops rekordbox writes', async () => {
    const lib = await parser().parseLibrary(write(xml(REAL_MARKS)));
    const track = lib.tracks.get('1')!;
    expect(track.cues).toHaveLength(2);
    expect(track.loops).toHaveLength(2);
    expect(track.cues![0]).toMatchObject({ start: 0.647, hotcue: -1, markType: 0 });
    expect(track.cues![1]).toMatchObject({ name: 'Drop', hotcue: 2, color: { red: 60, green: 235, blue: 80 } });
    expect(track.loops![1]).toMatchObject({ start: 16, end: 20, hotcue: 0 });
  });

  it('survives a save and a second read unchanged', async () => {
    const p = parser();
    const lib = await p.parseLibrary(write(xml(REAL_MARKS)));
    const out = write('');
    await p.saveLibrary(lib, out);
    const again = await p.parseLibrary(out);
    expect(again.tracks.get('1')!.cues).toHaveLength(2);
    expect(again.tracks.get('1')!.loops).toHaveLength(2);
    expect(again.tracks.get('1')!.cues).toEqual(lib.tracks.get('1')!.cues);
    expect(again.tracks.get('1')!.loops).toEqual(lib.tracks.get('1')!.loops);
  });

  it('writes the numeric types and Num that rekordbox reads', async () => {
    const p = parser();
    const lib = await p.parseLibrary(write(xml(REAL_MARKS)));
    const out = write('');
    await p.saveLibrary(lib, out);
    const saved = fs.readFileSync(out, 'utf8');
    expect(saved).not.toMatch(/Type="(CUE|LOOP)"/);
    expect(saved).toMatch(/<POSITION_MARK Name="" Type="0" Start="0.647" Num="-1"\/>/);
    expect(saved).toMatch(/Type="0" Start="7.078" Num="2" Red="60" Green="235" Blue="80"/);
    expect(saved).toMatch(/Type="4" Start="174.911" End="178.339" Num="-1"/);
  });

  it('still reads the words this app used to write', async () => {
    const lib = await parser().parseLibrary(write(xml(`      <POSITION_MARK Name="" Type="CUE" Start="1.0" Num="1"/>
      <POSITION_MARK Name="" Type="LOOP" Start="2.0" End="4.0"/>`)));
    expect(lib.tracks.get('1')!.cues).toHaveLength(1);
    expect(lib.tracks.get('1')!.loops).toHaveLength(1);
  });

  it('keeps every mark of a real export through a save', async () => {
    const fixture = path.resolve(__dirname, '../fixtures/rekordbox-working.xml');
    const inFile = (fs.readFileSync(fixture, 'utf8').match(/<POSITION_MARK/g) ?? []).length;
    const p = parser();
    const lib = await p.parseLibrary(fixture);
    const out = write('');
    await p.saveLibrary(lib, out);
    const saved = (fs.readFileSync(out, 'utf8').match(/<POSITION_MARK/g) ?? []).length;
    expect(inFile).toBeGreaterThan(12000);
    expect(saved).toBe(inFile);
  }, 60_000);
});
