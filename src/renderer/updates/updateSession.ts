import type { UpdateCheckResult, UpdateDownloadProgress, UpdateInstallResult } from '../../main/ipcContract';

export interface UpdateSnapshot {
  checking: boolean;
  result: UpdateCheckResult | null;
  error: string | null;
  downloading: boolean;
  progress: UpdateDownloadProgress | null;
  installed: UpdateInstallResult | null;
  dialogOpen: boolean;
}

const EMPTY: UpdateSnapshot = {
  checking: false, result: null, error: null, downloading: false, progress: null, installed: null, dialogOpen: false,
};

/**
 * The update check lives outside any component: the footer shows that a
 * version is waiting, the dialog installs it, and the menu opens that dialog
 * from wherever the app is. A download of a few hundred MB must also outlive
 * a tab switch.
 */
let state: UpdateSnapshot = EMPTY;
const listeners = new Set<() => void>();

const emit = (next: Partial<UpdateSnapshot>) => {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
};

export const subscribeUpdates = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const getUpdateSnapshot = (): UpdateSnapshot => state;

export const openUpdateDialog = (): void => emit({ dialogOpen: true });
export const closeUpdateDialog = (): void => emit({ dialogOpen: false });

/**
 * `silent` is the check at start-up: it says nothing unless there is
 * something new, and a failure — no network — stays out of the way.
 */
export async function checkForUpdates({ silent = false } = {}): Promise<UpdateCheckResult | null> {
  if (state.checking || state.downloading) { return state.result; }
  emit({ checking: true, error: null, installed: null });
  try {
    const res = await window.electronAPI.checkForUpdates();
    if (res.success && res.data) {
      emit({ result: res.data });
      return res.data;
    }
    if (!silent) { emit({ error: res.error ?? 'Could not check for updates.' }); }
    return null;
  } catch {
    if (!silent) { emit({ error: 'Could not check for updates.' }); }
    return null;
  } finally {
    emit({ checking: false });
  }
}

export async function installUpdate(): Promise<void> {
  if (state.downloading || !state.result?.available) { return; }
  emit({ downloading: true, progress: null, error: null, installed: null });
  const stop = window.electronAPI.onUpdateDownloadProgress((progress) => emit({ progress }));
  try {
    const res = await window.electronAPI.installUpdate();
    emit(res.success && res.data ? { installed: res.data } : { error: res.error ?? 'The update failed.' });
  } catch {
    emit({ error: 'The update failed.' });
  } finally {
    stop();
    emit({ downloading: false });
  }
}

export async function cancelUpdateDownload(): Promise<void> {
  if (state.downloading) { await window.electronAPI.cancelUpdateDownload(); }
}

/** For tests. */
export const resetUpdateSession = (): void => { state = EMPTY; };
