import type { GridBeat, PhraseAnalysis } from './anlzReader';

/**
 * Where auto hot cues go, from rekordbox's own phrase analysis.
 *
 * One cue at the start of each section — a run of phrases of one kind, so
 * three Drop phrases in a row are one Drop — named after it, in order,
 * on hot cues A to H. Placed on the beat the phrase starts on, or a bar
 * before when asked: a cue a bar early gives time to bring the track in.
 *
 * Only for a track with no hot cue at all. That rule is enforced where the
 * cues are written, against the database as it is then.
 */

export const MAX_HOT_CUES = 8;

/**
 * `djmdCue.Kind` for hot cue A through H. rekordbox skips 4, as
 * `hotcueSlot()` in the parser explains.
 */
export const HOT_CUE_KINDS = [1, 2, 3, 5, 6, 7, 8, 9] as const;

/**
 * Phrase names by mood. A high mood is what dance music mostly gets, and
 * there rekordbox's "Chorus" is the drop — so it is called one, as DJs and
 * the cues already in real libraries (`DROP`) call it. Mid and low moods are
 * songs with verses, where a chorus is a chorus; low repeats each verse name
 * three times over, as rekordbox does.
 */
const PHRASE_NAMES: Record<number, Record<number, string>> = {
  1: { 1: 'Intro', 2: 'Up', 3: 'Down', 5: 'Drop', 6: 'Outro' },
  2: { 1: 'Intro', 2: 'Verse 1', 3: 'Verse 2', 4: 'Verse 3', 5: 'Verse 4', 6: 'Verse 5', 7: 'Verse 6', 8: 'Bridge', 9: 'Chorus', 10: 'Outro' },
  3: { 1: 'Intro', 2: 'Verse 1', 3: 'Verse 1', 4: 'Verse 1', 5: 'Verse 2', 6: 'Verse 2', 7: 'Verse 2', 8: 'Bridge', 9: 'Chorus', 10: 'Outro' },
};

export const phraseName = (mood: number, kind: number): string | null => PHRASE_NAMES[mood]?.[kind] ?? null;

/**
 * Whether a beatgrid can place cues: every beat later than the one before.
 * A real library holds a grid that jumps back to the start two thirds of the
 * way through; a cue placed from it would land nowhere near its phrase.
 */
export const isUsableGrid = (grid: GridBeat[]): boolean =>
  grid.length > 0 && grid.every((b, i) => i === 0 || b.time > grid[i - 1].time);

export interface SuggestedCue {
  /** 0 for A through 7 for H. */
  slot: number;
  /** `djmdCue.Kind` for the slot. */
  kind: number;
  name: string;
  /** Milliseconds from the start of the track. */
  ms: number;
}

export interface SuggestOptions {
  /** Beats before the phrase: 0 on it, 4 a bar early. Never before the first beat. */
  beatsBefore: number;
}

/**
 * Which sections to keep when a track has more than eight. The intro and the
 * outro are where a mix starts and ends; drops, choruses and breakdowns
 * (Down, Bridge) are what a DJ jumps to; build-ups and verses come last.
 * Keeping simply the first eight left most tracks with nothing cued in their
 * second half — on a real library, 1072 of 1299 tracks have more.
 */
const priority = (name: string): number => {
  if (name === 'Intro' || name === 'Outro') { return 0; }
  if (name === 'Drop' || name === 'Chorus' || name === 'Down' || name === 'Bridge') { return 1; }
  return 2;
};

function keepEight<T extends { name: string; beat: number }>(sections: T[]): T[] {
  if (sections.length <= MAX_HOT_CUES) { return sections; }
  return [...sections]
    .sort((a, b) => priority(a.name) - priority(b.name) || a.beat - b.beat)
    .slice(0, MAX_HOT_CUES)
    .sort((a, b) => a.beat - b.beat);
}

/**
 * The cues for one track, or none when the analysis does not allow any. The
 * letters follow the track: A is the earliest cue, whatever was kept.
 */
export function suggestHotCues(
  grid: GridBeat[],
  analysis: PhraseAnalysis,
  { beatsBefore }: SuggestOptions
): SuggestedCue[] {
  const sections: Array<{ name: string; beat: number }> = [];
  for (const phrase of [...analysis.phrases].sort((a, b) => a.beat - b.beat)) {
    const name = phraseName(analysis.mood, phrase.kind);
    if (!name || phrase.beat < 1 || phrase.beat > grid.length) { continue; }
    if (sections.length > 0 && sections[sections.length - 1].name === name) { continue; }
    sections.push({ name, beat: phrase.beat });
  }

  const chosen = keepEight(sections);

  const cues: SuggestedCue[] = [];
  for (const section of chosen) {
    const ms = grid[Math.max(1, section.beat - beatsBefore) - 1].time;
    // A bar early can land two short sections on one beat; one cue is enough.
    if (cues.length > 0 && cues[cues.length - 1].ms >= ms) { continue; }
    cues.push({ slot: cues.length, kind: HOT_CUE_KINDS[cues.length], name: section.name, ms });
  }
  return cues;
}
