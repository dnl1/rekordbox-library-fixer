import type {
  ConversionFormatPayload, ConvertFlacProgress, ConvertFlacRequest, ConvertFlacSummary, IpcResult,
} from '../../main/ipcContract';

export interface ConversionSnapshot {
  running: boolean;
  libraryPath: string;
  format: ConversionFormatPayload | null;
  progress: ConvertFlacProgress | null;
  operationId: string | null;
  /** The last finished run, kept until it is dismissed or another starts. */
  summary: ConvertFlacSummary | null;
  error: string | null;
}

const EMPTY: ConversionSnapshot = {
  running: false, libraryPath: '', format: null, progress: null, operationId: null, summary: null, error: null,
};

/**
 * The FLAC conversion lives here rather than inside its panel, for the same
 * reason the duplicate scan does: the panel does not outlive what the run does
 * to the page. A write reloads the library, and the app shows a spinner in
 * place of the whole page while it parses — so the panel unmounted at the
 * very moment the result arrived, and the result was gone. Switching tabs
 * mid-run did the same to the progress.
 *
 * Module state survives both: the panel subscribes on mount and picks up a
 * run in progress or one that finished while it was away.
 */
let state: ConversionSnapshot = EMPTY;
const listeners = new Set<() => void>();

const emit = (next: Partial<ConversionSnapshot>) => {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
};

export const subscribeConversion = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const getConversionSnapshot = (): ConversionSnapshot => state;

export const resetConversionSession = (): void => {
  if (!state.running) { emit({ ...EMPTY }); }
};

export async function startConversion(
  request: Omit<ConvertFlacRequest, 'operationId'>
): Promise<IpcResult<ConvertFlacSummary>> {
  if (state.running) { return { success: false, error: 'A conversion is already running.' }; }

  const operationId = `convert-flac-${Date.now()}`;
  emit({
    ...EMPTY,
    running: true,
    libraryPath: request.libraryPath,
    format: request.format,
    operationId,
  });

  const stopProgress = window.electronAPI.onConvertFlacProgress((p) => {
    if (p.operationId === operationId) { emit({ progress: p }); }
  });

  try {
    const res = await window.electronAPI.convertFlac({ ...request, operationId });
    emit(res.success && res.data
      ? { summary: res.data }
      : { error: res.error ?? 'Conversion failed' });
    return res;
  } catch {
    const error = 'Conversion failed';
    emit({ error });
    return { success: false, error };
  } finally {
    stopProgress();
    emit({ running: false, progress: null });
  }
}

export async function cancelConversion(): Promise<void> {
  if (state.operationId && state.running) {
    await window.electronAPI.cancelConvertFlac(state.operationId);
  }
}
