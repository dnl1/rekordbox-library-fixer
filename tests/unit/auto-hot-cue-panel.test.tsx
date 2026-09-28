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

const api = () => (window as any).electronAPI;

const track = (id: string, title: string) => ({
  trackId: id, title, artist: 'Someone', location: `/m/${id}.mp3`,
  cues: [{ slot: 0, kind: 1, name: 'Intro', ms: 300 }, { slot: 1, kind: 2, name: 'Chorus', ms: 26881 }],
});

beforeEach(() => {
  context.libraryData = { tracks: new Map(), playlists: [] };
  context.libraryPath = '/pioneer/master.db';
  context.showNotification.mockReset();
  context.onLoadLibrary.mockReset();
  api().isRekordboxRunning = vi.fn(async () => ({ running: false }));
  api().autoHotCuePreview = vi.fn(async () => ({
    success: true,
    data: { tracks: [track('t1', 'First'), track('t2', 'Second')], alreadyCued: 33, notAnalysed: 40 },
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
