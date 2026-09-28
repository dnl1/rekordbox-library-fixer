import type {
  AutoHotCuePreview, AutoHotCuePreviewRequest, AutoHotCueProgress, IpcResult,
} from '../../main/ipcContract';

export interface HotCueSnapshot {
  running: boolean;
  libraryPath: string;
  progress: AutoHotCueProgress | null;
  operationId: string | null;
  /** The last finished suggestion run, kept until another starts or it is written. */
  preview: AutoHotCuePreview | null;
  error: string | null;
}

const EMPTY: HotCueSnapshot = {
  running: false, libraryPath: '', progress: null, operationId: null, preview: null, error: null,
};

/**
 * Suggesting hot cues decodes every track's bass, which on a whole collection
 * takes minutes. The run lives here, outside its panel, so switching tabs
 * meanwhile neither loses its progress nor its result — the pattern of
 * `convertFlacSession`.
 */
let state: HotCueSnapshot = EMPTY;
const listeners = new Set<() => void>();

const emit = (next: Partial<HotCueSnapshot>) => {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
};

export const subscribeHotCues = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const getHotCueSnapshot = (): HotCueSnapshot => state;

export const resetHotCueSession = (): void => {
  if (!state.running) { emit({ ...EMPTY }); }
};

export async function startHotCueSuggestions(
  request: Omit<AutoHotCuePreviewRequest, 'operationId'>
): Promise<IpcResult<AutoHotCuePreview>> {
  if (state.running) { return { success: false, error: 'Hot cues are already being suggested.' }; }

  const operationId = `auto-hot-cue-${Date.now()}`;
  emit({ ...EMPTY, running: true, libraryPath: request.libraryPath, operationId });
  const stopProgress = window.electronAPI.onAutoHotCueProgress((p) => {
    if (p.operationId === operationId) { emit({ progress: p }); }
  });

  try {
    const res = await window.electronAPI.autoHotCuePreview({ ...request, operationId });
    emit(res.success && res.data ? { preview: res.data } : { error: res.error ?? 'Preview failed' });
    return res;
  } catch {
    const error = 'Preview failed';
    emit({ error });
    return { success: false, error };
  } finally {
    stopProgress();
    emit({ running: false, progress: null });
  }
}

export async function cancelHotCueSuggestions(): Promise<void> {
  if (state.operationId && state.running) {
    await window.electronAPI.cancelAutoHotCue(state.operationId);
  }
}
