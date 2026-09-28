import * as crypto from 'crypto';
import * as fs from 'fs';
import * as mm from 'music-metadata';
import { Track } from './rekordboxParser';
import { Logger } from './logger';
import { FALLBACK_FIELDS, IDENTICAL_FILE_FIELDS } from './duplicateMatch';

export interface DuplicateSet {
  id: string;
  tracks: Track[];
  matchType: 'fingerprint' | 'metadata';
  confidence: number;
  /** The fields that were equal — shown with the set, since they are all the evidence there is. */
  matchedOn?: string[];
  /**
   * True when the files could not be read, so the set was matched on metadata
   * alone. Saying "2 entries · 1 file" for tracks whose files are all gone
   * implies something is on disk that is not.
   */
  filesMissing?: boolean;
}

export interface DuplicateOptions {
  useFingerprint: boolean;
  useMetadata: boolean;
  metadataFields: string[];
  pathPreferences?: string[];
  preferLossless?: boolean;
}

export interface ScanProgress {
  current: number;
  total: number;
  trackName?: string;
  setsFound: number;
}

export interface ScanHooks {
  /** Called as tracks are fingerprinted, so the UI can show progress. */
  onProgress?: (progress: ScanProgress) => void;
  /**
   * Called when a duplicate set is first discovered and again each time it
   * grows. The set id is stable across those emissions so the renderer can
   * upsert rather than append.
   */
  onDuplicateSet?: (set: DuplicateSet) => void;
  /** Checked between tracks; set `cancelled` to stop the scan early. */
  cancelToken?: { cancelled: boolean };
}

export interface ScanResult {
  duplicates: DuplicateSet[];
  cancelled: boolean;
}

/** Emit progress at most this often (tracks) to avoid flooding IPC. */
const PROGRESS_INTERVAL = 10;

export class DuplicateDetector {
  private fingerprintCache: Map<string, string> = new Map();
  /** Fingerprints that came from metadata because the file was unreadable. */
  private metadataFallbacks: Set<string> = new Set();
  private logger: Logger;

  constructor() {
    this.logger = new Logger();
  }

  async findDuplicates(
    tracks: Track[],
    options: DuplicateOptions,
    hooks: ScanHooks = {}
  ): Promise<ScanResult> {
    const { onProgress, onDuplicateSet, cancelToken } = hooks;
    const duplicateSets: DuplicateSet[] = [];
    const processedTracks = new Set<string>();
    let cancelled = false;

    // Create fingerprint map if using audio fingerprinting
    const fingerprintMap = new Map<string, Track[]>();
    if (options.useFingerprint) {
      // Stable set id per fingerprint, so a growing set keeps its identity.
      const setIdByFingerprint = new Map<string, string>();
      const emit = (fingerprint: string, group: Track[]) => {
        let id = setIdByFingerprint.get(fingerprint);
        if (!id) {
          id = crypto.createHash('md5').update(fingerprint).digest('hex').slice(0, 16);
          setIdByFingerprint.set(fingerprint, id);
        }
        const guessed = this.metadataFallbacks.has(fingerprint);
        onDuplicateSet?.({
          id,
          tracks: [...group],
          matchType: guessed ? 'metadata' : 'fingerprint',
          matchedOn: guessed ? FALLBACK_FIELDS : IDENTICAL_FILE_FIELDS,
          confidence: guessed ? 75 : 100,
          filesMissing: guessed,
        });
      };

      let index = 0;
      for (const track of tracks) {
        // Cancel is checked between tracks — each iteration is one file read,
        // so the response is prompt without aborting a read mid-flight.
        if (cancelToken?.cancelled) {
          cancelled = true;
          break;
        }

        try {
          const fingerprint = await this.generateFingerprint(track);
          if (!fingerprintMap.has(fingerprint)) {
            fingerprintMap.set(fingerprint, []);
          }
          const group = fingerprintMap.get(fingerprint)!;
          group.push(track);
          // A set exists from the second member on; re-emit as it grows.
          if (group.length > 1) { emit(fingerprint, group); }
        } catch (error) {
          console.error(`Failed to fingerprint track ${track.name}:`, error);
        }

        index++;
        if (onProgress && (index % PROGRESS_INTERVAL === 0 || index === tracks.length)) {
          const setsFound = Array.from(fingerprintMap.values()).filter(g => g.length > 1).length;
          onProgress({ current: index, total: tracks.length, trackName: track.name, setsFound });
        }
      }

      // Add fingerprint-based duplicates
      for (const [fingerprint, duplicateTracks] of fingerprintMap) {
        if (duplicateTracks.length > 1) {
          const guessed = this.metadataFallbacks.has(fingerprint);
          duplicateSets.push({
            id: setIdByFingerprint.get(fingerprint)
              ?? crypto.createHash('md5').update(fingerprint).digest('hex').slice(0, 16),
            tracks: duplicateTracks,
            // A set built from metadata is a strong hint, not proof the files
            // are identical: say so rather than claiming a content match.
            matchType: guessed ? 'metadata' : 'fingerprint',
            matchedOn: guessed ? FALLBACK_FIELDS : IDENTICAL_FILE_FIELDS,
            confidence: guessed ? 75 : 100,
            filesMissing: guessed,
          });
          duplicateTracks.forEach(t => processedTracks.add(t.id));
        }
      }
    }

    // A cancelled scan returns the partial results gathered so far; the
    // metadata pass below would otherwise report matches over a partial set.
    if (cancelled) {
      this.logger.logDuplicateDetection(tracks.length, duplicateSets.length, options);
      return { duplicates: duplicateSets, cancelled: true };
    }

    // Create metadata map if using metadata matching
    if (options.useMetadata) {
      const metadataMap = new Map<string, Track[]>();

      for (const track of tracks) {
        // Skip if already found as fingerprint duplicate
        if (processedTracks.has(track.id)) {continue;}

        const metadataKey = this.generateMetadataKey(track, options.metadataFields);
        if (!metadataMap.has(metadataKey)) {
          metadataMap.set(metadataKey, []);
        }
        metadataMap.get(metadataKey)!.push(track);
      }

      // Add metadata-based duplicates (fast: no file I/O, emitted in one batch)
      for (const [, duplicateTracks] of metadataMap) {
        if (duplicateTracks.length > 1) {
          const set: DuplicateSet = {
            id: crypto.randomBytes(8).toString('hex'),
            tracks: duplicateTracks,
            matchType: 'metadata',
            matchedOn: [...options.metadataFields],
            confidence: this.calculateMetadataConfidence(duplicateTracks, options.metadataFields),
          };
          duplicateSets.push(set);
          onDuplicateSet?.(set);
        }
      }
    }

    this.logger.logDuplicateDetection(tracks.length, duplicateSets.length, options);
    return { duplicates: duplicateSets, cancelled: false };
  }

  private async generateFingerprint(track: Track): Promise<string> {
    // Check cache first
    if (this.fingerprintCache.has(track.location)) {
      return this.fingerprintCache.get(track.location)!;
    }

    try {
      // Check if file exists
      await fs.promises.access(track.location);

      // Get audio metadata for fingerprinting
      const metadata = await mm.parseBuffer(await fs.promises.readFile(track.location));

      // Create a simplified fingerprint based on:
      // - Duration (rounded to nearest second)
      // - Average bitrate
      // - File size
      // - First 1MB of file content hash
      const duration = Math.round(metadata.format.duration || 0);
      const bitrate = metadata.format.bitrate || 0;
      const fileStats = await fs.promises.stat(track.location);

      // Read first 1MB for content hash
      const buffer = Buffer.alloc(1024 * 1024);
      const fd = await fs.promises.open(track.location, 'r');
      await fd.read(buffer, 0, buffer.length, 0);
      await fd.close();

      const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');

      const fingerprint = `${duration}_${bitrate}_${fileStats.size}_${contentHash}`;
      const hash = crypto.createHash('md5').update(fingerprint).digest('hex');

      // Cache the result
      this.fingerprintCache.set(track.location, hash);

      return hash;
    } catch {
      // The file is gone, so fall back to metadata. Exact file size is left out
      // on purpose: the same song re-tagged differs by a few kilobytes, which
      // split genuine duplicates into separate sets. Duration is rounded for
      // the same reason.
      const fallbackFingerprint = [
        (track.artist ?? '').trim().toLowerCase(),
        (track.name ?? '').trim().toLowerCase(),
        Math.round(track.duration ?? 0),
      ].join('_');
      const hash = crypto.createHash('md5').update(fallbackFingerprint).digest('hex');
      // Mark it so a guess is never presented as a content match.
      this.metadataFallbacks.add(hash);
      return hash;
    }
  }

  private generateMetadataKey(track: Track, fields: string[]): string {
    const keyParts: string[] = [];

    for (const field of fields) {
      switch (field) {
        case 'artist':
          keyParts.push(this.normalizeString(track.artist));
          break;
        case 'title':
          keyParts.push(this.normalizeString(track.name));
          break;
        case 'album':
          if (track.album) {keyParts.push(this.normalizeString(track.album));}
          break;
        case 'duration':
          if (track.duration) {keyParts.push(Math.round(track.duration).toString());}
          break;
        case 'bpm':
          if (track.bpm) {keyParts.push(Math.round(track.bpm).toString());}
          break;
        case 'key':
          if (track.key) {keyParts.push(track.key);}
          break;
      }
    }

    return keyParts.join('_');
  }

  private normalizeString(str: string): string {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .trim();
  }

  private calculateMetadataConfidence(tracks: Track[], fields: string[]): number {
    // Calculate confidence based on how many fields match
    let totalMatches = 0;
    let totalComparisons = 0;

    for (let i = 0; i < tracks.length - 1; i++) {
      for (let j = i + 1; j < tracks.length; j++) {
        for (const field of fields) {
          totalComparisons++;
          if (this.compareField(tracks[i], tracks[j], field)) {
            totalMatches++;
          }
        }
      }
    }

    return Math.round((totalMatches / totalComparisons) * 100);
  }

  private compareField(track1: Track, track2: Track, field: string): boolean {
    switch (field) {
      case 'artist':
        return this.normalizeString(track1.artist) === this.normalizeString(track2.artist);
      case 'title':
        return this.normalizeString(track1.name) === this.normalizeString(track2.name);
      case 'album':
        return track1.album && track2.album
          ? this.normalizeString(track1.album) === this.normalizeString(track2.album)
          : track1.album === track2.album;
      case 'duration':
        return track1.duration && track2.duration
          ? Math.abs(track1.duration - track2.duration) < 2 // Within 2 seconds
          : false;
      case 'bpm':
        return track1.bpm && track2.bpm
          ? Math.abs(track1.bpm - track2.bpm) < 1 // Within 1 BPM
          : false;
      case 'key':
        return track1.key === track2.key;
      default:
        return false;
    }
  }
}
