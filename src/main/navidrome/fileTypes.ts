/**
 * `djmdContent.FileType` for each extension rekordbox plays, as pyrekordbox
 * maps them. Anything else — Ogg, Opus, WMA — rekordbox cannot play, so it is
 * left on the server rather than downloaded for nothing.
 *
 * No Node imports here: the Navidrome page reads this too, to say which songs
 * will be left out before an import starts.
 */
export const REKORDBOX_FILE_TYPES: Record<string, number> = {
  mp3: 1, m4a: 4, flac: 5, wav: 11, aiff: 12, aif: 12,
};

export const fileTypeFor = (suffix: string): number | undefined => REKORDBOX_FILE_TYPES[(suffix ?? '').toLowerCase()];
