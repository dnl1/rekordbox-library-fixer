import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

const context = {
  libraryData: null as any,
  libraryPath: '',
  showNotification: vi.fn(),
  onLoadLibrary: vi.fn(),
};
vi.mock('../../src/renderer/AppWithRouter', () => ({ useAppContext: () => context }));

import { AutoHotCuePanel, formatCueTime } from '../../src/renderer/components/maintenance/AutoHotCuePanel';
import { resetHotCueSession } from '../../src/renderer/hotcues/autoHotCueSession';

const api = () => (window as any).electronAPI;

const track = (id: string, title: string) => ({
  trackId: id, title, artist: 'Someone', location: `/m/${id}.mp3`,
  cues: [{ slot: 0, kind: 1, name: 'Intro', ms: 300 }, { slot: 1, kind: 2, name: 'Chorus', ms: 26881 }],
});

beforeEach(() => {
  resetHotCueSession();
  context.libraryData = { tracks: new Map(), playlists: [] };
  context.libraryPath = '/pioneer/master.db';
  context.showNotification.mockReset();
  context.onLoadLibrary.mockReset();
  api().isRekordboxRunning = vi.fn(async () => ({ running: false }));
  api().onAutoHotCueProgress = vi.fn(() => () => undefined);
  api().cancelAutoHotCue = vi.fn(async () => ({ success: true }));
  api().autoHotCuePreview = vi.fn(async () => ({
    success: true,
    data: { tracks: [track('t1', 'First'), track('t2', 'Second')], alreadyCued: 33, notAnalysed: 40, withoutDrops: 0, cancelled: false },
  }));
  api().autoHotCueWrite = vi.fn(async () => ({
    success: true, data: { tracksWritten: 1, cuesWritten: 2, skipped: [], backupPath: '/b' },
  }));
});

describe('formatCueTime', () => {
  it('shows minutes, seconds and tenths', () => {
    expect(formatCueTime(26881)).toBe('0:26.9');
    expect(formatCueTime(314700)).toBe('5:14.7');
    expect(formatCueTime(59960)).toBe('1:00.0');
  });
});

describe('AutoHotCuePanel', () => {
  it('is for rekordbox’s database only', () => {
    context.libraryPath = '/x/collection.xml';
    render(<AutoHotCuePanel />);
    expect(screen.getByText(/Only for rekordbox.s own database/)).toBeTruthy();
  });

  it('shows the suggestions and what was left out, and writes nothing yet', async () => {
    render(<AutoHotCuePanel />);
    fireEvent.click(screen.getByRole('button', { name: /Suggest hot cues/ }));
    await waitFor(() => expect(screen.getByText(/2 tracks to cue/)).toBeTruthy());
    expect(screen.getByText(/33 already have hot cues/)).toBeTruthy();
    expect(screen.getByText(/40 have no phrase analysis/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /B Chorus 0:26.9/ })).toHaveLength(2);
    expect(api().autoHotCueWrite).not.toHaveBeenCalled();
  });

  it('asks for the cues on the phrase unless a bar early is chosen', async () => {
    render(<AutoHotCuePanel />);
    fireEvent.change(screen.getByLabelText(/Place each cue/), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: /Suggest hot cues/ }));
    await waitFor(() => expect(api().autoHotCuePreview).toHaveBeenCalledWith(expect.objectContaining({ beatsBefore: 4 })));
  });

  it('analyses with the number of workers set in Performance', async () => {
    const { useSettingsStore } = await import('../../src/renderer/stores/settingsStore');
    useSettingsStore.getState().setWorkers(6);
    render(<AutoHotCuePanel />);
    fireEvent.click(screen.getByRole('button', { name: /Suggest hot cues/ }));
    await waitFor(() => expect(api().autoHotCuePreview).toHaveBeenCalledWith(expect.objectContaining({ workers: 6 })));
  });

  it('shows progress and busy workers, and offers to cancel while it listens for drops', async () => {
    let finish: (v: unknown) => void = () => {};
    let push: (p: unknown) => void = () => {};
    api().onAutoHotCueProgress = vi.fn((cb: (p: unknown) => void) => { push = cb; return () => undefined; });
    api().autoHotCuePreview = vi.fn((req: { operationId: string }) => {
      setTimeout(() => push({ operationId: req.operationId, current: 3, total: 10, active: 4, currentFile: 'Nostalgia' }), 0);
      return new Promise((resolve) => { finish = resolve; });
    });
    render(<AutoHotCuePanel />);
    fireEvent.click(screen.getByRole('button', { name: /Suggest hot cues/ }));
    await waitFor(() => expect(screen.getByText('4 workers in progress')).toBeTruthy());
    expect(screen.getByText('3 / 10')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(api().cancelAutoHotCue).toHaveBeenCalled();
    finish({ success: true, data: { tracks: [], alreadyCued: 0, notAnalysed: 0, withoutDrops: 0, cancelled: true } });
    await waitFor(() => expect(screen.getByText(/Stopped early/)).toBeTruthy());
  });

  it('writes only the tracks left ticked, then reopens the library', async () => {
    render(<AutoHotCuePanel />);
    fireEvent.click(screen.getByRole('button', { name: /Suggest hot cues/ }));
    fireEvent.click(await screen.findByLabelText('Cue Second'));
    fireEvent.click(screen.getByRole('button', { name: /Add hot cues to 1 tracks/ }));
    await waitFor(() => expect(api().autoHotCueWrite).toHaveBeenCalled());
    expect(api().autoHotCueWrite.mock.calls[0][0].tracks).toEqual([
      { trackId: 't1', cues: [{ kind: 1, name: 'Intro', ms: 300 }, { kind: 2, name: 'Chorus', ms: 26881 }] },
    ]);
    await waitFor(() => expect(context.onLoadLibrary).toHaveBeenCalledWith('/pioneer/master.db'));
  });

  it('refuses to write while rekordbox is open', async () => {
    api().isRekordboxRunning = vi.fn(async () => ({ running: true }));
    render(<AutoHotCuePanel />);
    fireEvent.click(screen.getByRole('button', { name: /Suggest hot cues/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Add hot cues to 2 tracks/ }));
    await waitFor(() => expect(context.showNotification).toHaveBeenCalledWith('error', expect.stringMatching(/Close rekordbox/)));
    expect(api().autoHotCueWrite).not.toHaveBeenCalled();
  });
});
