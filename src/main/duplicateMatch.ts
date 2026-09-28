/**
 * Which algorithm put a duplicate set together, in words a DJ can check.
 *
 * "Fingerprint" was the name of a comparison of file size, length, bitrate and
 * the first megabyte of the file — which finds identical copies of one file
 * and nothing else. The same song as an AIFF and a WAV, or bought twice from
 * two shops, never matches it; calling it a fingerprint made people expect an
 * acoustic match and wonder why their duplicates were still there. Pure, so
 * the renderer imports it too.
 */

export type MatchType = 'fingerprint' | 'metadata';

/** What the identical-file comparison looks at. */
export const IDENTICAL_FILE_FIELDS = ['file size', 'length', 'bitrate', 'first 1 MB of the file'];

/** What a set falls back to when its files cannot be read. */
export const FALLBACK_FIELDS = ['artist', 'title', 'length'];

const FIELD_NAMES: Record<string, string> = { duration: 'length', name: 'title' };

export interface MatchDescription {
  /** Short: shown on every set. */
  method: string;
  /** Which fields were equal — the whole of the evidence. */
  detail: string;
}

const list = (fields: string[]) =>
  fields.length <= 1 ? fields.join('') : `${fields.slice(0, -1).join(', ')} and ${fields[fields.length - 1]}`;

export function describeMatch(
  set: { matchType: MatchType; filesMissing?: boolean; matchedOn?: string[] }
): MatchDescription {
  if (set.matchType === 'fingerprint' && !set.filesMissing) {
    return {
      method: 'Identical files',
      detail: `Same ${list(set.matchedOn ?? IDENTICAL_FILE_FIELDS)} — copies of one file`,
    };
  }
  if (set.filesMissing) {
    return {
      method: 'Metadata · files unreadable',
      detail: `The files could not be read, so matched on the same ${list(set.matchedOn ?? FALLBACK_FIELDS)}`,
    };
  }
  const fields = (set.matchedOn ?? ['artist', 'title', 'duration']).map((f) => FIELD_NAMES[f] ?? f);
  return { method: 'Metadata', detail: `Same ${list(fields)} — the files themselves may differ` };
}
