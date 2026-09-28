import type {
  FlacCleanupProgress, FlacCleanupRequest, FlacCleanupSummary, IpcResult,
} from '../../main/ipcContract';

export interface CleanupSnapshot {
  running: boolean;
  libraryPath: string;
  progress: FlacCleanupProgress | null;
  operationId: string | null;
  /** The last finished run, kept until it is dismissed or another starts. */
  summary: FlacCleanupSummary | null;
  error: string | null;
}

const EMPTY: CleanupSnapshot = {
  running: false, libraryPath: '', progress: null, operationId: null, summary: null, error: null,
};

/**
 * The FLAC cleanup, outside its panel for the reason `convertFlacSession`
 * gives: decoding every pair takes minutes, and switching tabs meanwhile
 * unmounted the panel and lost the run's progress and result.
 */
let state: CleanupSnapshot = EMPTY;
const listeners = new Set<() => void>();

const emit = (next: Partial<CleanupSnapshot>) => {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
};

export const subscribeCleanup = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const getCleanupSnapshot = (): CleanupSnapshot => state;

export const resetCleanupSession = (): void => {
  if (!state.running) { emit({ ...EMPTY }); }
};

export async function startCleanup(
  request: Omit<FlacCleanupRequest, 'operationId'>
): Promise<IpcResult<FlacCleanupSummary>> {
  if (state.running) { return { success: false, error: 'A cleanup is already running.' }; }

  const operationId = `cleanup-flac-${Date.now()}`;
  emit({ ...EMPTY, running: true, libraryPath: request.libraryPath, operationId });

  const stopProgress = window.electronAPI.onCleanupFlacProgress((p) => {
    if (p.operationId === operationId) { emit({ progress: p }); }
  });

  try {
    const res = await window.electronAPI.cleanupFlac({ ...request, operationId });
    emit(res.success && res.data ? { summary: res.data } : { error: res.error ?? 'Cleanup failed' });
    return res;
  } catch {
    const error = 'Cleanup failed';
    emit({ error });
    return { success: false, error };
  } finally {
    stopProgress();
    emit({ running: false, progress: null });
  }
}

export async function cancelCleanup(): Promise<void> {
  // The main process keeps one table of runs in flight for conversions and cleanups.
  if (state.operationId && state.running) {
    await window.electronAPI.cancelConvertFlac(state.operationId);
  }
}
