import { convertedPath, type ConversionFormat, type ConvertedFile } from './flacConverter';
import type { ConversionWritePlan, ConversionWriteSkip } from './rekordboxDbConverter';

/**
 * What a conversion run means for the library once the files exist: which
 * entries to re-point, and afterwards which files to keep, remove or trash.
 * Kept apart from the handler so each rule can be tested on its own — these
 * decide which audio files survive.
 */

/**
 * One write per entry: a file two entries point at is written twice.
 *
 * The converter works on paths as this machine's disk has them; the library
 * is written in its own spelling. `libraryLocation` maps one back to the
 * other — under WSL, `/mnt/c/…` back to the `C:/…` rekordbox stored — and the
 * new location is derived from the library's spelling, not the disk's.
 */
export function writePlansFor(
  converted: ConvertedFile[],
  libraryLocation: (hostPath: string) => string = (p) => p
): ConversionWritePlan[] {
  return converted.flatMap((file) => {
    const oldLocation = libraryLocation(file.oldLocation);
    const newLocation = oldLocation === file.oldLocation ? file.newLocation : convertedPath(oldLocation, file.format);
    return file.trackIds.map((trackId) => ({
      trackId,
      oldLocation,
      newLocation,
    format: file.format,
    size: file.size,
    sampleRate: file.sampleRate,
    bitDepth: file.bitDepth,
      bitRate: file.bitRate,
    }));
  });
}

export interface Settlement {
  /** Converted files at least one entry now points at. */
  kept: ConvertedFile[];
  /** Converted files no entry points at — nothing would ever find them. */
  orphaned: string[];
  /** Originals every entry has left, and so may go to the trash if asked. */
  trashable: string[];
}

/**
 * Settle each converted file against the entries that were actually updated.
 *
 * An original is trashable only when every entry that pointed at it now
 * points at the conversion: one entry left behind — skipped because it moved
 * in rekordbox since the library was loaded, or outside the playlist being
 * converted (`stillUsed`) — still needs the FLAC.
 */
export function settleConversions(
  converted: ConvertedFile[],
  updatedTrackIds: Set<string>,
  stillUsed: Set<string> = new Set()
): Settlement {
  const settlement: Settlement = { kept: [], orphaned: [], trashable: [] };
  for (const file of converted) {
    const updated = file.trackIds.filter((id) => updatedTrackIds.has(id));
    if (updated.length === 0) {
      settlement.orphaned.push(file.newLocation);
      continue;
    }
    settlement.kept.push(file);
    if (updated.length === file.trackIds.length && !stillUsed.has(file.oldLocation.normalize('NFC'))) {
      settlement.trashable.push(file.oldLocation);
    }
  }
  return settlement;
}

/**
 * Where the entries that were not re-pointed still point, in NFC. A
 * conversion limited to one playlist can meet a FLAC that another entry,
 * outside the playlist, also uses; that entry still needs the file, so the
 * file must not go to the trash with the playlist's.
 */
export function locationsStillUsed(
  allTracks: Array<{ id: string; location: string }>,
  updatedTrackIds: Set<string>
): Set<string> {
  return new Set(
    allTracks
      .filter((t) => !updatedTrackIds.has(t.id) && t.location)
      .map((t) => t.location.normalize('NFC'))
  );
}

/** The `Kind` rekordbox writes in its XML for each format. */
export const XML_KIND: Record<ConversionFormat, string> = { aiff: 'AIFF File', wav: 'WAV File', mp3: 'MP3 File' };

interface XmlTrack {
  location: string;
  kind?: string;
  size?: number;
  bitrate?: number;
  sampleRate?: number;
}

/**
 * Apply the conversions to an XML library held in memory. Same re-check as
 * the database writer: an entry that no longer points at the converted file
 * is left alone.
 *
 * Note what an XML library can and cannot do here: rekordbox matches an
 * imported track by its location, so importing this XML adds the converted file
 * as a track next to the FLAC rather than replacing it. The database path
 * does not have that problem, which is why it is the one to prefer.
 */
export function applyConversionsToLibrary(
  tracks: Map<string, XmlTrack>,
  plans: ConversionWritePlan[]
): { tracksUpdated: number; updatedTrackIds: Set<string>; skipped: ConversionWriteSkip[] } {
  const updatedTrackIds = new Set<string>();
  const skipped: ConversionWriteSkip[] = [];
  for (const plan of plans) {
    const track = tracks.get(plan.trackId);
    if (!track) { skipped.push({ trackId: plan.trackId, reason: 'not in the library' }); continue; }
    if ((track.location ?? '').normalize('NFC') !== plan.oldLocation.normalize('NFC')) {
      skipped.push({ trackId: plan.trackId, reason: 'it points at a different file than when the library was loaded' });
      continue;
    }
    track.location = plan.newLocation;
    track.kind = XML_KIND[plan.format];
    track.size = plan.size;
    track.bitrate = plan.bitRate;
    track.sampleRate = plan.sampleRate;
    updatedTrackIds.add(plan.trackId);
  }
  return { tracksUpdated: updatedTrackIds.size, updatedTrackIds, skipped };
}
