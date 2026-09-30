import type { IpcResult, PlaylistZipProgress, PlaylistZipRequest, PlaylistZipSummary } from '../../main/ipcContract';

export interface PlaylistZipSnapshot {
  running: boolean;
  /** The playlist being exported, by its `playlistScopes` key. */
  scopeKey: string;
  progress: PlaylistZipProgress | null;
  operationId: string | null;
  /** The last finished run, kept until it is dismissed or another starts. */
  summary: PlaylistZipSummary | null;
  error: string | null;
}

const EMPTY: PlaylistZipSnapshot = {
  running: false, scopeKey: '', progress: null, operationId: null, summary: null, error: null,
};

/**
 * An export of a few GB takes minutes, and the panel does not outlive a tab
 * switch — so the run lives here, as the FLAC conversion's does, and the
 * panel picks it up again when it mounts.
 */
let state: PlaylistZipSnapshot = EMPTY;
const listeners = new Set<() => void>();

const emit = (next: Partial<PlaylistZipSnapshot>) => {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
};

export const subscribePlaylistZip = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const getPlaylistZipSnapshot = (): PlaylistZipSnapshot => state;

export const resetPlaylistZipSession = (): void => {
  if (!state.running) { emit({ ...EMPTY }); }
};

export async function startPlaylistZip(
  scopeKey: string, request: Omit<PlaylistZipRequest, 'operationId'>
): Promise<IpcResult<PlaylistZipSummary>> {
  if (state.running) { return { success: false, error: 'An export is already running.' }; }

  const operationId = `playlist-zip-${Date.now()}`;
  emit({ ...EMPTY, running: true, scopeKey, operationId });

  const stopProgress = window.electronAPI.onPlaylistZipProgress((p) => {
    if (p.operationId === operationId) { emit({ progress: p }); }
  });

  try {
    const res = await window.electronAPI.exportPlaylistZip({ ...request, operationId });
    emit(res.success && res.data ? { summary: res.data } : { error: res.error ?? 'Export failed' });
    return res;
  } catch {
    const error = 'Export failed';
    emit({ error });
    return { success: false, error };
  } finally {
    stopProgress();
    emit({ running: false, progress: null });
  }
}

export async function cancelPlaylistZip(): Promise<void> {
  if (state.operationId && state.running) {
    await window.electronAPI.cancelPlaylistZip(state.operationId);
  }
}
