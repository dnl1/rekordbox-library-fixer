import * as fs from 'fs';
import * as path from 'path';

/**
 * Read the two things auto hot cues need out of rekordbox's analysis files:
 * the beatgrid (`PQTZ`) and the phrase analysis (`PSSI`).
 *
 * Each analysed track has an `ANLZ0000.DAT` and an `ANLZ0000.EXT` under the
 * `share` directory beside `master.db`, at the path `djmdContent.AnalysisDataPath`
 * names (the `.DAT`). Both are big-endian: a `PMAI` file header, then tags, each
 * starting with its four-letter type, its header length and its total length.
 * The layout follows the Deep Symmetry analysis of the export format and
 * pyrekordbox's reading of it, and was checked against a real rekordbox 7
 * library. Only these two tags are read; nothing is ever written.
 */

export interface GridBeat {
  /** Position in the bar, 1–4. */
  beat: number;
  /** BPM × 100. */
  tempo: number;
  /** Milliseconds from the start of the track. */
  time: number;
}

export interface Phrase {
  /** 1-based index into the beatgrid. */
  beat: number;
  /** What the phrase is; its meaning depends on the mood. */
  kind: number;
}

export interface PhraseAnalysis {
  /** 1 high, 2 mid, 3 low — which set of phrase names applies. */
  mood: number;
  endBeat: number;
  phrases: Phrase[];
}

export interface TrackAnalysis {
  grid: GridBeat[] | null;
  phrases: PhraseAnalysis | null;
}

/**
 * rekordbox masks the phrase entries it *exports* — and, in the library, some
 * versions store them the same way. Every byte after the entry count is XORed
 * with this pattern plus the entry count. A mood outside 1–3 gives it away.
 */
const PSSI_MASK = [
  0xcb, 0xe1, 0xee, 0xfa, 0xe5, 0xee, 0xad, 0xee, 0xe9, 0xd2, 0xe9, 0xeb, 0xe1, 0xe9, 0xf3, 0xe8, 0xe9, 0xf4, 0xe1,
];

const PQTZ_ENTRY = 8;
const PSSI_ENTRY = 24;

function readGrid(tag: Buffer): GridBeat[] | null {
  // type, len_header, len_tag, 4 unknown bytes, a constant 0x80000, the count.
  if (tag.length < 24) { return null; }
  const count = tag.readUInt32BE(20);
  const start = tag.readUInt32BE(4);
  if (start + count * PQTZ_ENTRY > tag.length) { return null; }
  const grid: GridBeat[] = [];
  for (let i = 0; i < count; i++) {
    const o = start + i * PQTZ_ENTRY;
    grid.push({ beat: tag.readUInt16BE(o), tempo: tag.readUInt16BE(o + 2), time: tag.readUInt32BE(o + 4) });
  }
  return grid;
}

function unmaskPhrases(tag: Buffer): Buffer {
  const mood = tag.readUInt16BE(18);
  if (mood >= 1 && mood <= 3) { return tag; }
  const count = tag.readUInt16BE(16);
  const out = Buffer.from(tag);
  for (let x = 0; x + 18 < out.length; x++) {
    out[18 + x] ^= (PSSI_MASK[x % PSSI_MASK.length] + count) & 0xff;
  }
  return out;
}

function readPhrases(raw: Buffer): PhraseAnalysis | null {
  // type, len_header (32), len_tag, entry size (24), count, mood, 6 unknown,
  // end beat, 2 unknown, bank, 1 unknown — then the entries.
  if (raw.length < 32 || raw.readUInt32BE(12) !== PSSI_ENTRY) { return null; }
  const tag = unmaskPhrases(raw);
  const mood = tag.readUInt16BE(18);
  if (mood < 1 || mood > 3) { return null; }
  const count = tag.readUInt16BE(16);
  const start = tag.readUInt32BE(4);
  if (start + count * PSSI_ENTRY > tag.length) { return null; }
  const phrases: Phrase[] = [];
  for (let i = 0; i < count; i++) {
    const o = start + i * PSSI_ENTRY;
    phrases.push({ beat: tag.readUInt16BE(o + 2), kind: tag.readUInt16BE(o + 4) });
  }
  return { mood, endBeat: tag.readUInt16BE(26), phrases };
}

/** The tags of one ANLZ file, by type. A file that is not one gives none. */
export function anlzTags(file: Buffer): Map<string, Buffer> {
  const tags = new Map<string, Buffer>();
  if (file.length < 12 || file.toString('ascii', 0, 4) !== 'PMAI') { return tags; }
  const end = Math.min(file.readUInt32BE(8), file.length);
  let o = file.readUInt32BE(4);
  while (o + 12 <= end) {
    const type = file.toString('ascii', o, o + 4);
    const length = file.readUInt32BE(o + 8);
    if (length < 12 || o + length > end) { break; }
    if (!tags.has(type)) { tags.set(type, file.subarray(o, o + length)); }
    o += length;
  }
  return tags;
}

export function parseAnalysis(files: Buffer[]): TrackAnalysis {
  let grid: GridBeat[] | null = null;
  let phrases: PhraseAnalysis | null = null;
  for (const file of files) {
    const tags = anlzTags(file);
    const pqtz = tags.get('PQTZ');
    const pssi = tags.get('PSSI');
    if (!grid && pqtz) { grid = readGrid(pqtz); }
    if (!phrases && pssi) { phrases = readPhrases(pssi); }
  }
  return {
    grid: grid && grid.length > 0 ? grid : null,
    phrases: phrases && phrases.phrases.length > 0 ? phrases : null,
  };
}

/**
 * The analysis of one track. `analysisDataPath` is what the database stores —
 * `/PIONEER/USBANLZ/…/ANLZ0000.DAT`, relative to the `share` directory beside
 * `master.db`. The `.EXT` beside it holds the phrases.
 */
export function readTrackAnalysis(dbPath: string, analysisDataPath: string | null | undefined): TrackAnalysis {
  if (!analysisDataPath) { return { grid: null, phrases: null }; }
  const dat = path.join(path.dirname(dbPath), 'share', analysisDataPath);
  const ext = dat.replace(/\.DAT$/i, '.EXT');
  const files: Buffer[] = [];
  for (const file of [dat, ext]) {
    try { files.push(fs.readFileSync(file)); } catch { /* not analysed that far */ }
  }
  return parseAnalysis(files);
}
