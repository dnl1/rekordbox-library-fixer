import { formatDuration, formatFileSize } from './formatters';

/**
 * Where the copies in a duplicate set differ — what a DJ weighs when picking
 * the one to keep: the format, its quality, the length, the tags, the cues.
 *
 * The path is never a difference. Every copy of a song lives somewhere else,
 * so "the path differs" is true of every set and says nothing about the files;
 * it is shown on each copy anyway.
 */

export interface DiffTrack {
  id: string;
  name?: string;
  artist?: string;
  album?: string;
  genre?: string;
  location?: string;
  kind?: string;
  duration?: number;
  bitrate?: number;
  size?: number;
  sampleRate?: number;
  bitDepth?: number;
  bpm?: number;
  key?: string;
  rating?: number;
  dateAdded?: string | Date;
  cues?: unknown[];
  loops?: unknown[];
}

export interface TrackDifference {
  field: string;
  label: string;
  /** The value of each copy, by track id, as shown. */
  values: Record<string, string>;
}

const NONE = '—';

/** The format from the file's extension — the one thing both XML and database libraries always have. */
export const formatOf = (t: DiffTrack): string => {
  const ext = /\.([a-z0-9]+)$/i.exec(t.location ?? '')?.[1];
  return ext ? ext.toUpperCase().replace(/^AIF$/, 'AIFF') : (t.kind ?? NONE);
};

interface Field {
  field: string;
  label: string;
  show: (t: DiffTrack) => string;
  /** What is compared, when it is finer than what is shown. */
  compare?: (t: DiffTrack) => string;
}

const FIELDS: Field[] = [
  { field: 'format', label: 'Format', show: formatOf },
  { field: 'bitrate', label: 'Bitrate', show: (t) => (t.bitrate ? `${t.bitrate} kbps` : NONE) },
  { field: 'sampleRate', label: 'Sample rate', show: (t) => (t.sampleRate ? `${t.sampleRate / 1000} kHz` : NONE) },
  { field: 'bitDepth', label: 'Bit depth', show: (t) => (t.bitDepth ? `${t.bitDepth}-bit` : NONE) },
  { field: 'duration', label: 'Length', show: (t) => (t.duration ? formatDuration(Math.round(t.duration)) : NONE) },
  // Exact bytes decide: the display rounds, so two sizes can differ and read alike.
  { field: 'size', label: 'Size', show: (t) => (t.size ? formatFileSize(t.size) : NONE), compare: (t) => String(t.size ?? '') },
  { field: 'artist', label: 'Artist', show: (t) => t.artist?.trim() || NONE },
  { field: 'name', label: 'Title', show: (t) => t.name?.trim() || NONE },
  { field: 'album', label: 'Album', show: (t) => t.album?.trim() || NONE },
  { field: 'genre', label: 'Genre', show: (t) => t.genre?.trim() || NONE },
  { field: 'bpm', label: 'BPM', show: (t) => (t.bpm ? t.bpm.toFixed(2) : NONE) },
  { field: 'key', label: 'Key', show: (t) => t.key || NONE },
  { field: 'rating', label: 'Rating', show: (t) => `${t.rating || 0}/5` },
  { field: 'cues', label: 'Cues', show: (t) => String(t.cues?.length ?? 0) },
  { field: 'loops', label: 'Loops', show: (t) => String(t.loops?.length ?? 0) },
  {
    field: 'dateAdded',
    label: 'Added',
    show: (t) => (t.dateAdded ? new Date(t.dateAdded).toISOString().slice(0, 10) : NONE),
  },
];

/** The fields on which the copies do not all agree, in order of what matters most. */
export function trackDifferences(tracks: DiffTrack[]): TrackDifference[] {
  if (tracks.length < 2) { return []; }
  const out: TrackDifference[] = [];
  for (const { field, label, show, compare = show } of FIELDS) {
    if (new Set(tracks.map(compare)).size < 2) { continue; }
    const values: Record<string, string> = {};
    for (const t of tracks) { values[t.id] = show(t); }
    out.push({ field, label, values });
  }
  return out;
}
