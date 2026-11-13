import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

const context = {
  libraryPath: '/pioneer/master.db',
  showNotification: vi.fn(),
  onLoadLibrary: vi.fn(),
  onOpenSettings: vi.fn(),
};
vi.mock('../../src/renderer/AppWithRouter', () => ({ useAppContext: () => context }));

import { NavidromePage, formatDuration } from '../../src/renderer/components/pages/NavidromePage';
import { useSettingsStore } from '../../src/renderer/stores/settingsStore';
import { usePendingHotCuesStore } from '../../src/renderer/stores/pendingHotCuesStore';

const api = () => (window as any).electronAPI;
const summary = {
  downloaded: 3, reused: 0, skipped: [], failed: [], tracksAdded: 3, tracksAlreadyThere: 0, trackIds: ['11', '12', '13'],
  convertedToAiff: 2, notConverted: [], playlists: [{ name: 'Peak', tracks: 3 }], playlistFileUpdated: true, cancelled: false, backupPath: '/b',
};

/** "Import into rekordbox", then the dialog's own Import. */
const importWith = async (dialog?: (d: HTMLElement) => void) => {
  fireEvent.click(screen.getByRole('button', { name: /Import into rekordbox/ }));
  const d = await screen.findByRole('dialog', { name: 'Import into rekordbox' });
  dialog?.(d);
  fireEvent.click(screen.getByRole('button', { name: /^Import$/ }));
};

beforeEach(() => {
  context.libraryPath = '/pioneer/master.db';
  Object.values(context).forEach((v) => typeof v === 'function' && (v as any).mockReset?.());
  useSettingsStore.setState({ navidromeDestination: '', rekordboxDbKey: 'the-key', navidromeConvertToAiff: true, navidromeAutoHotCues: true, workers: 4 });
  usePendingHotCuesStore.setState({ byLibrary: {} });
  api().navidromeConnection = vi.fn(async () => ({ success: true, data: { url: 'https://music.example.com', username: 'dj', hasPassword: true } }));
  api().navidromeDefaultDestination = vi.fn(async () => ({ success: true, data: '/Users/dj/Music/Navidrome' }));
  api().navidromePlaylists = vi.fn(async () => ({ success: true, data: [
    { id: 'p1', name: 'Peak', songCount: 3, duration: 1200 },
    { id: 'p2', name: 'Warm up', songCount: 5, duration: 3700 },
  ] }));
  api().navidromeSearch = vi.fn(async () => ({ success: true, data: [
    { id: 's1', title: 'Explorers', artist: 'Avalon', album: 'Psy', genre: '', suffix: 'flac', duration: 412 },
    { id: 's2', title: 'Ogg thing', artist: 'X', album: 'Y', genre: '', suffix: 'ogg', duration: 100 },
  ] }));
  api().navidromeImport = vi.fn(async () => ({ success: true, data: summary }));
  api().cancelNavidromeImport = vi.fn(async () => ({ success: true }));
  api().onNavidromeImportProgress = vi.fn(() => () => undefined);
  api().isRekordboxRunning = vi.fn(async () => ({ running: false }));
});

describe('formatDuration', () => {
  it('shows hours only when there are some', () => {
    expect(formatDuration(412)).toBe('6:52');
    expect(formatDuration(3700)).toBe('1:01:40');
    expect(formatDuration(undefined)).toBe('—');
  });
});

describe('NavidromePage', () => {
  it('sends you to Settings when no server is set up', async () => {
    api().navidromeConnection = vi.fn(async () => ({ success: true, data: null }));
    render(<NavidromePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up Navidrome' }));
    expect(context.onOpenSettings).toHaveBeenCalledWith('navidrome');
  });

  it('lists the playlists, and says who is connected where', async () => {
    render(<NavidromePage />);
    expect(await screen.findByLabelText('Peak')).toBeTruthy();
    expect(screen.getByText('dj @ music.example.com')).toBeTruthy();
    expect(screen.getByText('1:01:40')).toBeTruthy();
  });

  it('imports the picked playlists and songs into the open database, to the default folder', async () => {
    render(<NavidromePage />);
    fireEvent.click(await screen.findByLabelText('Peak'));
    fireEvent.click(screen.getByRole('tab', { name: /Search songs/ }));
    fireEvent.change(screen.getByLabelText('Search songs'), { target: { value: 'avalon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByLabelText('Avalon — Explorers'));
    await waitFor(() => expect((screen.getByLabelText('Download to') as HTMLInputElement).value).toBe('/Users/dj/Music/Navidrome'));
    expect(screen.getByText(/1 playlist and 1 song picked — about 4 tracks/)).toBeTruthy();

    await importWith();
    await waitFor(() => expect(api().navidromeImport).toHaveBeenCalledWith(expect.objectContaining({
      libraryPath: '/pioneer/master.db', dbKey: 'the-key', destination: '/Users/dj/Music/Navidrome', playlistIds: ['p1'], songIds: ['s1'],
      convertToAiff: true, workers: 4,
    })));
    expect(await screen.findByText(/3 tracks added; playlists: Peak \(3\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load the updated library' }));
    expect(context.onLoadLibrary).toHaveBeenCalledWith('/pioneer/master.db');
  });

  it('will not pick a song rekordbox cannot play', async () => {
    render(<NavidromePage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Search songs/ }));
    fireEvent.change(screen.getByLabelText('Search songs'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(((await screen.findByLabelText('X — Ogg thing')) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('rekordbox cannot play this')).toBeTruthy();
  });

  it('asks for rekordbox\'s database before it imports, but browses without one', async () => {
    context.libraryPath = '/x/collection.xml';
    render(<NavidromePage />);
    fireEvent.click(await screen.findByLabelText('Peak'));
    expect(screen.getByText(/Open rekordbox.s database in the Library tab to import/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Import into rekordbox/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses while rekordbox is open, before anything is downloaded', async () => {
    api().isRekordboxRunning = vi.fn(async () => ({ running: true }));
    render(<NavidromePage />);
    fireEvent.click(await screen.findByLabelText('Peak'));
    await importWith();
    await waitFor(() => expect(context.showNotification).toHaveBeenCalledWith('error', expect.stringMatching(/Close rekordbox first/)));
    expect(api().navidromeImport).not.toHaveBeenCalled();
  });

  it('says a cancelled import added nothing', async () => {
    api().navidromeImport = vi.fn(async () => ({ success: true, data: { ...summary, cancelled: true, tracksAdded: 0, playlists: [] } }));
    render(<NavidromePage />);
    fireEvent.click(await screen.findByLabelText('Peak'));
    await importWith();
    expect(await screen.findByText(/Cancelled — nothing was added to rekordbox/)).toBeTruthy();
    expect(usePendingHotCuesStore.getState().byLibrary).toEqual({});
  });

  it('asks whether to convert to AIFF and add hot cues, ticked as last time', async () => {
    useSettingsStore.setState({ navidromeConvertToAiff: false, navidromeAutoHotCues: true });
    render(<NavidromePage />);
    fireEvent.click(await screen.findByLabelText('Peak'));
    fireEvent.click(screen.getByRole('button', { name: /Import into rekordbox/ }));
    await screen.findByRole('dialog', { name: 'Import into rekordbox' });
    expect((screen.getByLabelText(/Convert to AIFF/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/Add hot cues/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/FLAC, WAV and M4A become AIFF/)).toBeTruthy();
    expect(api().navidromeImport).not.toHaveBeenCalled();
  });

  it('imports as chosen in the dialog, and remembers the choice', async () => {
    render(<NavidromePage />);
    fireEvent.click(await screen.findByLabelText('Peak'));
    await importWith(() => {
      fireEvent.click(screen.getByLabelText(/Convert to AIFF/));
      fireEvent.click(screen.getByLabelText(/Add hot cues/));
    });
    await waitFor(() => expect(api().navidromeImport).toHaveBeenCalledWith(expect.objectContaining({ convertToAiff: false })));
    expect(useSettingsStore.getState()).toMatchObject({ navidromeConvertToAiff: false, navidromeAutoHotCues: false });
    await screen.findByText(/3 tracks added/);
    expect(usePendingHotCuesStore.getState().byLibrary).toEqual({});
  });

  it('imports nothing when the dialog is cancelled', async () => {
    render(<NavidromePage />);
    fireEvent.click(await screen.findByLabelText('Peak'));
    fireEvent.click(screen.getByRole('button', { name: /Import into rekordbox/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api().navidromeImport).not.toHaveBeenCalled();
  });

  it('queues hot cues for the imported tracks until rekordbox has analysed them', async () => {
    render(<NavidromePage />);
    fireEvent.click(await screen.findByLabelText('Peak'));
    await importWith();
    expect(await screen.findByText(/Hot cues for 3 tracks are queued until rekordbox has analysed them/)).toBeTruthy();
    expect(screen.getByText(/2 imported as AIFF/)).toBeTruthy();
    expect(usePendingHotCuesStore.getState().byLibrary['/pioneer/master.db']).toEqual(['11', '12', '13']);
    expect(screen.getByText(/3 imported tracks wait for hot cues/)).toBeTruthy();
  });

  it('adds the queued hot cues on request, and reloads the library', async () => {
    usePendingHotCuesStore.setState({ byLibrary: { '/pioneer/master.db': ['11', '12'] } });
    api().autoHotCuePreview = vi.fn(async () => ({ success: true, data: {
      tracks: [{ trackId: '11', title: 'T', artist: 'A', location: '/l', cues: [{ slot: 0, kind: 1, name: 'Intro', ms: 0 }] }],
      alreadyCued: 0, notAnalysed: 1, withoutDrops: 0, waitingIds: ['12'], cancelled: false,
    } }));
    api().autoHotCueWrite = vi.fn(async () => ({ success: true, data: { tracksWritten: 1, cuesWritten: 1, skipped: [], backupPath: '/b' } }));
    render(<NavidromePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add hot cues now' }));
    await waitFor(() => expect(context.onLoadLibrary).toHaveBeenCalledWith('/pioneer/master.db'));
    expect(context.showNotification).toHaveBeenCalledWith('success', expect.stringMatching(/Added 1 hot cue to 1 imported track\. 1 still wait/), { important: true });
    expect(usePendingHotCuesStore.getState().byLibrary['/pioneer/master.db']).toEqual(['12']);
  });
});
