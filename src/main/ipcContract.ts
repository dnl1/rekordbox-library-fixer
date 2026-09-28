/**
 * The contract between the two processes.
 *
 * Both sides import these: `preload.ts` types what it exposes, the renderer
 * types `window.electronAPI` from the same file, and the handlers type their
 * arguments from it. It lives under `src/main` because that is where the
 * bridge is defined; the renderer's import is type-only and disappears at
 * build time. Keeping one copy is the point — the renderer used to
 * declare its own shapes, and a field the main process stopped sending stayed
 * in the renderer's type, so the code that read it compiled and got undefined.
 */

/** Anything crossing the bridge is structured-cloned, so Dates arrive as strings. */
export type Serialized<T> = T extends Date ? string
  : T extends Array<infer U> ? Array<Serialized<U>>
  : T extends Map<infer K, infer V> ? Map<K, Serialized<V>>
  : T extends object ? { [K in keyof T]: Serialized<T[K]> }
  : T;

export interface IpcResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

/** A track as it crosses the bridge. Loose on purpose: the XML and the
 *  database carry different subsets, and neither side gains from pretending
 *  otherwise. What every caller may rely on is named. */
export interface TrackPayload {
  id: string;
  name: string;
  artist: string;
  location: string;
  album?: string;
  genre?: string;
  bpm?: number;
  key?: string;
  size?: number;
  bitrate?: number;
  duration?: number;
  rating?: number;
  dateAdded?: string | Date;
  dateModified?: string | Date;
  [field: string]: unknown;
}

export interface DuplicateSet {
  id: string;
  tracks: TrackPayload[];
  matchType: 'fingerprint' | 'metadata';
  confidence: number;
  /** The fields that were equal. Absent on sets cached before it was recorded. */
  matchedOn?: string[];
  filesMissing?: boolean;
  pathPreferences?: string[];
}

export interface ScanOptionsPayload {
  useFingerprint: boolean;
  useMetadata: boolean;
  metadataFields: string[];
  pathPreferences?: string[];
  preferLossless?: boolean;
  tracks?: TrackPayload[];
}

export interface ScanProgressPayload {
  operationId?: string;
  type?: 'start' | 'progress' | 'complete';
  current: number;
  total: number;
  trackName?: string;
  setsFound: number;
}

export interface MergePlanPayload {
  keepId: string;
  removeIds: string[];
}

export interface BrokenEntryPayload {
  trackId: string;
  name: string;
  artist: string;
  location: string;
  reason: string;
}

/** An entry left alone by a removal, and why — reported so a run that removed
 *  fewer entries than it listed does not look like a failure. */
export interface KeptEntry {
  trackId: string;
  reason: string;
}

export interface RelocationPayload {
  trackId: string;
  oldLocation: string;
  newLocation: string;
}

export interface RelocationResultPayload {
  trackId: string;
  oldLocation: string;
  /** Empty when nothing was found — a failure still says where it looked. */
  newLocation?: string;
  success: boolean;
  error?: string;
  confidence?: number;
  trackName?: string;
}

export interface RelocateProgressPayload {
  operationId?: string;
  type: 'start' | 'searching' | 'found' | 'low-confidence' | 'not-found'
    | 'updating-xml' | 'complete' | 'cancelled' | 'error';
  total: number;
  current: number;
  successCount?: number;
  trackName?: string;
  trackArtist?: string;
  confidence?: number;
  newLocation?: string;
  message: string;
  error?: string;
}

export interface FoundLibraryPayload {
  kind: 'database' | 'xml';
  path: string;
  label: string;
  size: number;
  modified: string;
}

export interface BackupPayload {
  path: string;
  libraryPath?: string;
  size: number;
  created: string;
}

export interface OperationProgress {
  operationId: string;
  current: number;
  total: number;
  message?: string;
  trackName?: string;
}

export interface FilterRulePayload {
  field: 'artist' | 'album' | 'genre' | 'rating' | 'bpm' | 'year' | 'format';
  op: 'contains' | 'equals' | 'gte' | 'lte';
  value: string;
}

/** The database key, as pyrekordbox printed it on this machine. */
export interface RecoveredDbKey {
  key: string;
}

export type ConversionFormatPayload = 'aiff' | 'wav' | 'mp3';

/** What a FLAC conversion would do, before it runs. */
export interface ConvertFlacPreview {
  /** False when this build carries no ffmpeg for the platform it runs on. */
  available: boolean;
  flacTracks: number;
  /** Distinct files: entries sharing one FLAC share its conversion. Includes `reusable`. */
  files: number;
  /**
   * Of those, the ones whose AIFF or WAV is already there — usually a run that
   * stopped before it wrote the library. Each is used if it decodes to exactly
   * the FLAC's audio, and left alone if not.
   */
  reusable: number;
  missing: number;
  /** A file of the target format and the same name already there, which is left alone. */
  conflicts: number;
  totalSizeBytes: number;
}

export interface ConvertFlacRequest {
  operationId: string;
  /** The whole library, always: an original is trashed only if nothing else uses it. */
  tracks: TrackPayload[];
  /** Convert only these entries — a playlist on its way to a USB stick. Absent means all. */
  scopeTrackIds?: string[];
  libraryPath: string;
  /** Required when `libraryPath` is a master.db. */
  dbKey?: string;
  format: ConversionFormatPayload;
  /**
   * Move each original to the trash once every entry points at its conversion.
   * Honoured for master.db only: after an XML conversion rekordbox's own
   * database still points at the FLACs.
   */
  trashOriginals: boolean;
  /** How many files are converted at once. */
  workers?: number;
}

export interface ConvertFlacProgress {
  operationId: string;
  current: number;
  total: number;
  /** Workers busy right now. */
  active: number;
  currentFile: string;
  converted: number;
  skipped: number;
  failed: number;
}

export interface ConvertFlacSummary {
  filesConverted: number;
  tracksUpdated: number;
  skipped: Array<{ trackId: string; location?: string; reason: string }>;
  failed: Array<{ file: string; error: string }>;
  cancelled: boolean;
  trashed: string[];
  trashFailed: Array<{ file: string; error: string }>;
  backupPath?: string;
}

/** FLACs left beside the AIFF or WAV the library now uses, before any is checked. */
export interface FlacCleanupPreview {
  /** False when this build carries no ffmpeg, which the audio check needs. */
  available: boolean;
  /** FLACs no entry uses, each beside a lossless file an entry does use. */
  files: number;
  totalSizeBytes: number;
  /** FLACs beside a conversion that an entry still points at — Convert's to settle. */
  stillUsed: number;
}

export interface FlacCleanupRequest {
  operationId: string;
  /** The whole library: a FLAC any entry points at is never a candidate. */
  tracks: TrackPayload[];
  /** A master.db only: an XML library says nothing about what rekordbox itself uses. */
  libraryPath: string;
  dbKey: string;
  /** How many FLACs are compared with their conversion at once. */
  workers?: number;
}

export interface FlacCleanupProgress {
  operationId: string;
  current: number;
  total: number;
  /** Workers busy right now. */
  active: number;
  currentFile: string;
}

export interface FlacCleanupSummary {
  trashed: string[];
  freedBytes: number;
  kept: Array<{ file: string; reason: string }>;
  failed: Array<{ file: string; error: string }>;
  cancelled: boolean;
}

/** One suggested hot cue. */
export interface AutoHotCuePayload {
  /** 0 for A through 7 for H. */
  slot: number;
  /** `djmdCue.Kind` for the slot — 1, 2, 3, 5, 6, 7, 8, 9. */
  kind: number;
  /** The phrase it starts: Intro, Up, Drop, Down, Outro… */
  name: string;
  ms: number;
}

export interface AutoHotCueTrack {
  trackId: string;
  title: string;
  artist: string;
  location: string;
  cues: AutoHotCuePayload[];
}

export interface AutoHotCuePreviewRequest {
  operationId: string;
  libraryPath: string;
  dbKey: string;
  /** Limit to a playlist or folder. Absent means the whole collection. */
  scopeTrackIds?: string[];
  /** 0 puts each cue on its phrase, 4 a bar before it. */
  beatsBefore: number;
  /** How many tracks' audio is analysed at once. */
  workers: number;
}

export interface AutoHotCueProgress {
  operationId: string;
  current: number;
  total: number;
  /** Workers busy right now. */
  active: number;
  currentFile: string;
}

export interface AutoHotCuePreview {
  tracks: AutoHotCueTrack[];
  /** Left out: they already have a hot cue. */
  alreadyCued: number;
  /** Left out: no phrase analysis, or no beatgrid to place cues on — analyse them in rekordbox. */
  notAnalysed: number;
  /** Cued from the phrases alone: the audio could not be read for drops, or this build has no ffmpeg. */
  withoutDrops: number;
  cancelled: boolean;
}

export interface AutoHotCueWriteRequest {
  libraryPath: string;
  dbKey: string;
  /** The previewed cues of the tracks that stayed ticked. */
  tracks: Array<{ trackId: string; cues: Array<{ kind: number; name: string; ms: number }> }>;
}

export interface AutoHotCueWriteSummary {
  tracksWritten: number;
  cuesWritten: number;
  skipped: Array<{ trackId: string; reason: string }>;
  backupPath: string;
}

/** Unsubscribes an event listener registered through the bridge. */
export type Unsubscribe = () => void;
