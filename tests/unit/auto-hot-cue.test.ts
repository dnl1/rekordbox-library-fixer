import { describe, it, expect } from 'vitest';
import { anlzTags, parseAnalysis, type GridBeat } from '../../src/main/anlzReader';
import { suggestHotCues, isUsableGrid, phraseName } from '../../src/main/autoHotCue';

// ─── Building ANLZ files the way rekordbox lays them out ─────────────────────

const tag = (type: string, header: Buffer, body: Buffer): Buffer => {
  const out = Buffer.concat([Buffer.alloc(12), header, body]);
  out.write(type, 0, 'ascii');
  out.writeUInt32BE(12 + header.length, 4);
  out.writeUInt32BE(out.length, 8);
  return out;
};

const anlzFile = (...tags: Buffer[]): Buffer => {
  const header = Buffer.alloc(28);
  header.write('PMAI', 0, 'ascii');
  header.writeUInt32BE(28, 4);
  const file = Buffer.concat([header, ...tags]);
  file.writeUInt32BE(file.length, 8);
  return file;
};

const pqtz = (beats: GridBeat[]): Buffer => {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(0x80000, 4);
  header.writeUInt32BE(beats.length, 8);
  const body = Buffer.alloc(beats.length * 8);
  beats.forEach((b, i) => { body.writeUInt16BE(b.beat, i * 8); body.writeUInt16BE(b.tempo, i * 8 + 2); body.writeUInt32BE(b.time, i * 8 + 4); });
  return tag('PQTZ', header, body);
};

const MASK = [0xcb, 0xe1, 0xee, 0xfa, 0xe5, 0xee, 0xad, 0xee, 0xe9, 0xd2, 0xe9, 0xeb, 0xe1, 0xe9, 0xf3, 0xe8, 0xe9, 0xf4, 0xe1];

const pssi = (mood: number, phrases: Array<[number, number]>, masked = false): Buffer => {
  const header = Buffer.alloc(20);
  header.writeUInt32BE(24, 0);
  header.writeUInt16BE(phrases.length, 4);
  header.writeUInt16BE(mood, 6);
  header.writeUInt16BE(999, 14);
  const body = Buffer.alloc(phrases.length * 24);
  phrases.forEach(([beat, kind], i) => { body.writeUInt16BE(i + 1, i * 24); body.writeUInt16BE(beat, i * 24 + 2); body.writeUInt16BE(kind, i * 24 + 4); });
  const out = tag('PSSI', header, body);
  if (masked) {
    for (let x = 0; x + 18 < out.length; x++) { out[18 + x] ^= (MASK[x % MASK.length] + phrases.length) & 0xff; }
  }
  return out;
};

/** A steady grid: `count` beats at `bpm`, the first at `first` ms. */
const steadyGrid = (count: number, bpm = 120, first = 0): GridBeat[] =>
  Array.from({ length: count }, (_, i) => ({ beat: (i % 4) + 1, tempo: bpm * 100, time: Math.round(first + (i * 60000) / bpm) }));

describe('parseAnalysis', () => {
  const grid = steadyGrid(8);

  it('reads the beatgrid from the .DAT and the phrases from the .EXT', () => {
    const dat = anlzFile(pqtz(grid));
    const ext = anlzFile(pqtz(grid), pssi(1, [[1, 1], [5, 2]]));
    const a = parseAnalysis([dat, ext]);
    expect(a.grid).toEqual(grid);
    expect(a.phrases).toEqual({ mood: 1, endBeat: 999, phrases: [{ beat: 1, kind: 1 }, { beat: 5, kind: 2 }] });
  });

  it('unmasks the phrase entries rekordbox stores XORed', () => {
    const a = parseAnalysis([anlzFile(pssi(1, [[1, 1], [33, 5], [65, 3]], true))]);
    expect(a.phrases?.mood).toBe(1);
    expect(a.phrases?.phrases).toEqual([{ beat: 1, kind: 1 }, { beat: 33, kind: 5 }, { beat: 65, kind: 3 }]);
  });

  it('skips tags it does not read, and gives nothing for a file that is not ANLZ', () => {
    const other = tag('PWAV', Buffer.alloc(8), Buffer.alloc(40));
    expect(parseAnalysis([anlzFile(other, pqtz(grid))]).grid).toEqual(grid);
    expect(anlzTags(Buffer.from('not an analysis file at all')).size).toBe(0);
    expect(parseAnalysis([Buffer.alloc(0)])).toEqual({ grid: null, phrases: null });
  });

  it('stops at a tag whose length runs past the file rather than reading garbage', () => {
    const broken = pqtz(grid);
    broken.writeUInt32BE(1_000_000, 8);
    expect(parseAnalysis([anlzFile(broken)]).grid).toBeNull();
  });
});

describe('phraseName', () => {
  it('names phrases by mood, as rekordbox shows them', () => {
    expect([1, 2, 3, 5, 6].map((k) => phraseName(1, k))).toEqual(['Intro', 'Up', 'Down', 'Drop', 'Outro']);
  });

  it('calls a high-mood chorus a drop, and keeps a song\'s chorus a chorus', () => {
    expect(phraseName(1, 5)).toBe('Drop');
    expect(phraseName(2, 9)).toBe('Chorus');
    expect(phraseName(3, 4)).toBe('Verse 1');
    expect(phraseName(1, 4)).toBeNull();
  });
});

describe('isUsableGrid', () => {
  it('refuses a grid that jumps back — a real library has one', () => {
    expect(isUsableGrid(steadyGrid(4))).toBe(true);
    expect(isUsableGrid([...steadyGrid(4), { beat: 1, tempo: 4888, time: 331 }])).toBe(false);
    expect(isUsableGrid([])).toBe(false);
  });
});

describe('suggestHotCues', () => {
  const grid = steadyGrid(400, 120);
  const at = (beat: number) => grid[beat - 1].time;
  const analysis = (phrases: Array<[number, number]>, mood = 1) => ({ mood, endBeat: 400, phrases: phrases.map(([beat, kind]) => ({ beat, kind })) });

  it('puts one cue at the start of each section, in order, on A onwards', () => {
    const cues = suggestHotCues(grid, analysis([[1, 1], [33, 2], [65, 5], [97, 3], [129, 6]]), { beatsBefore: 0 });
    expect(cues).toEqual([
      { slot: 0, kind: 1, name: 'Intro', ms: at(1) },
      { slot: 1, kind: 2, name: 'Up', ms: at(33) },
      { slot: 2, kind: 3, name: 'Drop', ms: at(65) },
      { slot: 3, kind: 5, name: 'Down', ms: at(97) },
      { slot: 4, kind: 6, name: 'Outro', ms: at(129) },
    ]);
  });

  it('counts a run of phrases of one kind as one section', () => {
    const cues = suggestHotCues(grid, analysis([[1, 1], [33, 5], [65, 5], [97, 5], [129, 3]]), { beatsBefore: 0 });
    expect(cues.map((c) => c.name)).toEqual(['Intro', 'Drop', 'Down']);
  });

  it('places a cue a bar early when asked, but never before the first beat', () => {
    const cues = suggestHotCues(grid, analysis([[1, 1], [33, 5]]), { beatsBefore: 4 });
    expect(cues.map((c) => c.ms)).toEqual([at(1), at(29)]);
  });

  it('with more than eight sections keeps intro, outro, drops and breakdowns before build-ups', () => {
    // Intro, then Up/Chorus/Down three times, then Outro: eleven sections.
    const phrases: Array<[number, number]> = [[1, 1]];
    let beat = 17;
    for (let i = 0; i < 3; i++) { for (const kind of [2, 5, 3]) { phrases.push([beat, kind]); beat += 32; } }
    phrases.push([beat, 6]);
    const cues = suggestHotCues(grid, analysis(phrases), { beatsBefore: 0 });
    expect(cues).toHaveLength(8);
    expect(cues.map((c) => c.name)).toEqual(['Intro', 'Drop', 'Down', 'Drop', 'Down', 'Drop', 'Down', 'Outro']);
    expect(cues.map((c) => c.kind)).toEqual([1, 2, 3, 5, 6, 7, 8, 9]);
    expect(cues.every((c, i) => i === 0 || c.ms > cues[i - 1].ms)).toBe(true);
  });

  it('ignores a phrase past the end of the grid, and one it has no name for', () => {
    expect(suggestHotCues(grid, analysis([[1, 1], [500, 5], [33, 4]]), { beatsBefore: 0 }).map((c) => c.name)).toEqual(['Intro']);
  });
});
