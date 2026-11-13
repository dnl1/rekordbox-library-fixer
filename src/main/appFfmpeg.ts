import { app } from 'electron';
import { resolveFfmpegPath } from './ffmpegBinary';

/** This app's bundled ffmpeg, or null when this build has none for the platform. */
export const appFfmpegPath = (): string | null => resolveFfmpegPath({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
  platform: process.platform,
  arch: process.arch,
});
