import type { IpcResult } from '../../main/ipcContract';
import { useSettingsStore } from '../stores/settingsStore';
import { usePendingHotCuesStore } from '../stores/pendingHotCuesStore';

export interface PendingHotCuesOutcome {
  /** Tracks that got hot cues now. */
  tracksWritten: number;
  cuesWritten: number;
  /** Still waiting: rekordbox has not analysed them yet. */
  waiting: number;
  /** Nothing was tried: rekordbox is open, and the cues are written into its database. */
  rekordboxOpen?: boolean;
  backupPath?: string;
}

let inFlight: Promise<IpcResult<PendingHotCuesOutcome>> | null = null;

/**
 * Give the tracks waiting in `libraryPath` their hot cues, as the Auto hot cues
 * tool would with every suggestion kept — the import that queued them already
 * said yes. Only rekordbox's analysis is waited on: a track that has it now is
 * cued, or settled if it cannot be (cued by hand meanwhile, gone from the
 * collection, a grid that cannot place cues); the rest stay queued. With
 * rekordbox open nothing is tried, and nothing leaves the queue.
 */
export function applyPendingHotCues(libraryPath: string): Promise<IpcResult<PendingHotCuesOutcome>> {
  if (!inFlight) {
    inFlight = run(libraryPath).finally(() => { inFlight = null; });
  }
  return inFlight;
}

async function run(libraryPath: string): Promise<IpcResult<PendingHotCuesOutcome>> {
  const pending = usePendingHotCuesStore.getState().byLibrary[libraryPath] ?? [];
  const none = { tracksWritten: 0, cuesWritten: 0, waiting: pending.length };
  if (pending.length === 0) { return { success: true, data: none }; }

  const { running } = await window.electronAPI.isRekordboxRunning();
  if (running) { return { success: true, data: { ...none, rekordboxOpen: true } }; }

  const { rekordboxDbKey: dbKey, workers } = useSettingsStore.getState();
  const preview = await window.electronAPI.autoHotCuePreview({
    operationId: `pending-hot-cues-${Date.now()}`, libraryPath, dbKey, scopeTrackIds: pending, beatsBefore: 0, workers,
  });
  if (!preview.success || !preview.data) { return { success: false, error: preview.error ?? 'The hot cues could not be suggested' }; }

  let tracksWritten = 0;
  let cuesWritten = 0;
  let backupPath: string | undefined;
  if (preview.data.tracks.length > 0) {
    const written = await window.electronAPI.autoHotCueWrite({
      libraryPath,
      dbKey,
      tracks: preview.data.tracks.map((t) => ({ trackId: t.trackId, cues: t.cues.map(({ kind, name, ms }) => ({ kind, name, ms })) })),
    });
    if (!written.success || !written.data) { return { success: false, error: written.error ?? 'The hot cues could not be written' }; }
    ({ tracksWritten, cuesWritten, backupPath } = written.data);
  }

  const stillWaiting = new Set(preview.data.waitingIds);
  const waiting = pending.filter((id) => stillWaiting.has(id));
  usePendingHotCuesStore.getState().keep(libraryPath, waiting);
  return { success: true, data: { tracksWritten, cuesWritten, waiting: waiting.length, backupPath } };
}

/** What to tell the user after a run that did something, or null when there is nothing to say. */
export function describePendingOutcome(outcome: PendingHotCuesOutcome): string | null {
  if (outcome.tracksWritten === 0) { return null; }
  const tracks = `${outcome.tracksWritten} imported track${outcome.tracksWritten === 1 ? '' : 's'}`;
  const waiting = outcome.waiting > 0
    ? ` ${outcome.waiting} still wait for rekordbox to analyse them.`
    : '';
  return `Added ${outcome.cuesWritten} hot cue${outcome.cuesWritten === 1 ? '' : 's'} to ${tracks}.${waiting}`
    + '\nA backup was saved first — undo from the Backups tab.';
}
