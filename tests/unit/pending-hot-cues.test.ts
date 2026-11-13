import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyPendingHotCues, describePendingOutcome } from '../../src/renderer/hotcues/pendingHotCues';
import { usePendingHotCuesStore } from '../../src/renderer/stores/pendingHotCuesStore';
import { useSettingsStore } from '../../src/renderer/stores/settingsStore';

const api = () => (window as any).electronAPI;
const LIB = '/pioneer/master.db';
const cue = (trackId: string) => ({ trackId, title: 'T', artist: 'A', location: '/l', cues: [{ slot: 0, kind: 1, name: 'Intro', ms: 0 }] });

beforeEach(() => {
  usePendingHotCuesStore.setState({ byLibrary: { [LIB]: ['1', '2', '3'] } });
  useSettingsStore.setState({ rekordboxDbKey: 'k', workers: 2 });
  api().isRekordboxRunning = vi.fn(async () => ({ running: false }));
  api().autoHotCuePreview = vi.fn(async () => ({ success: true, data: {
    tracks: [cue('1')], alreadyCued: 1, notAnalysed: 1, withoutDrops: 0, waitingIds: ['3'], cancelled: false,
  } }));
  api().autoHotCueWrite = vi.fn(async () => ({ success: true, data: { tracksWritten: 1, cuesWritten: 1, skipped: [], backupPath: '/b' } }));
});

describe('applyPendingHotCues', () => {
  it('cues the analysed tracks with every suggestion, and keeps waiting on the rest', async () => {
    const res = await applyPendingHotCues(LIB);
    expect(api().autoHotCuePreview).toHaveBeenCalledWith(expect.objectContaining({ libraryPath: LIB, dbKey: 'k', scopeTrackIds: ['1', '2', '3'], beatsBefore: 0, workers: 2 }));
    expect(api().autoHotCueWrite).toHaveBeenCalledWith({ libraryPath: LIB, dbKey: 'k', tracks: [{ trackId: '1', cues: [{ kind: 1, name: 'Intro', ms: 0 }] }] });
    expect(res.data).toMatchObject({ tracksWritten: 1, waiting: 1 });
    // 2 was cued by hand meanwhile: settled, not waited on.
    expect(usePendingHotCuesStore.getState().byLibrary[LIB]).toEqual(['3']);
  });

  it('tries nothing while rekordbox is open, and keeps the whole queue', async () => {
    api().isRekordboxRunning = vi.fn(async () => ({ running: true }));
    const res = await applyPendingHotCues(LIB);
    expect(res.data).toMatchObject({ rekordboxOpen: true, waiting: 3 });
    expect(api().autoHotCuePreview).not.toHaveBeenCalled();
    expect(usePendingHotCuesStore.getState().byLibrary[LIB]).toEqual(['1', '2', '3']);
  });

  it('keeps the queue when the write fails', async () => {
    api().autoHotCueWrite = vi.fn(async () => ({ success: false, error: 'locked' }));
    const res = await applyPendingHotCues(LIB);
    expect(res).toEqual({ success: false, error: 'locked' });
    expect(usePendingHotCuesStore.getState().byLibrary[LIB]).toEqual(['1', '2', '3']);
  });

  it('writes nothing when no track is analysed yet', async () => {
    api().autoHotCuePreview = vi.fn(async () => ({ success: true, data: {
      tracks: [], alreadyCued: 0, notAnalysed: 3, withoutDrops: 0, waitingIds: ['1', '2', '3'], cancelled: false,
    } }));
    const res = await applyPendingHotCues(LIB);
    expect(api().autoHotCueWrite).not.toHaveBeenCalled();
    expect(res.data).toMatchObject({ tracksWritten: 0, waiting: 3 });
    expect(describePendingOutcome(res.data!)).toBeNull();
  });

  it('runs once at a time: a second call shares the first', async () => {
    const [a, b] = await Promise.all([applyPendingHotCues(LIB), applyPendingHotCues(LIB)]);
    expect(a).toBe(b);
    expect(api().autoHotCuePreview).toHaveBeenCalledTimes(1);
  });

  it('forgets a library whose queue is empty', async () => {
    api().autoHotCuePreview = vi.fn(async () => ({ success: true, data: {
      tracks: [cue('1'), cue('2'), cue('3')], alreadyCued: 0, notAnalysed: 0, withoutDrops: 0, waitingIds: [], cancelled: false,
    } }));
    await applyPendingHotCues(LIB);
    expect(usePendingHotCuesStore.getState().byLibrary).toEqual({});
  });
});
