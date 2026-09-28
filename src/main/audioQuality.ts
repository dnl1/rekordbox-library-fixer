/** WAV and AIFF — lossless and universally supported on CDJ hardware. */
export const UNIVERSAL_LOSSLESS_EXTENSIONS: readonly string[] = ['.wav', '.aiff', '.aif'];

/** FLAC — lossless but CDJ support depends on hardware generation. */
export const FLAC_EXTENSIONS: readonly string[] = ['.flac'];

export const LOSSLESS_EXTENSIONS: readonly string[] = [...FLAC_EXTENSIONS, ...UNIVERSAL_LOSSLESS_EXTENSIONS];

function ext(location: string): string {
  return '.' + (location.split('.').pop()?.toLowerCase() ?? '');
}

/** WAV/AIFF: lossless AND universally CDJ-compatible — always preferred over lossy. */
export function isUniversalLossless(location: string): boolean {
  return UNIVERSAL_LOSSLESS_EXTENSIONS.includes(ext(location));
}

/** FLAC: lossless but CDJ support varies — only prefer when user explicitly opts in. */
export function isFlac(location: string): boolean {
  return ext(location) === '.flac';
}

/** AIFF: lossless, universally supported, and carries tags and artwork. */
export function isAiff(location: string): boolean {
  return ['.aiff', '.aif'].includes(ext(location));
}

/**
 * How a file ranks before bitrate and size are looked at — higher wins.
 *
 * AIFF sits above WAV: both are lossless and play on every CDJ, but WAV keeps
 * almost no tags or artwork, so of two lossless copies the AIFF is the one worth
 * keeping. FLAC joins WAV only when the user opts in, since older players
 * cannot read it. Lossy formats are left to bitrate and size.
 *
 * Kept free of Node imports: the renderer's duplicate badge uses it too, so the
 * copy it marks is the copy the main process would keep.
 */
export function qualityTier(location: string, preferFlac = false): number {
  if (isAiff(location)) { return 3; }
  if (isUniversalLossless(location)) { return 2; }
  if (preferFlac && isFlac(location)) { return 2; }
  return 0;
}

/** Returns `true` for any lossless format (FLAC, WAV, AIFF). */
export function isLossless(location: string): boolean {
  return LOSSLESS_EXTENSIONS.includes(ext(location));
}
