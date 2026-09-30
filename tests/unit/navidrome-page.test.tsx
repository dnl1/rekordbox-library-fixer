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

const api = () => (window as any).electronAPI;
const summary = { downloaded: 3, reused: 0, skipped: [], failed: [], tracksAdded: 3, tracksAlreadyThere: 0, playlists: [{ name: 'Peak', tracks: 3 }], playlistFileUpdated: true, cancelled: false, backupPath: '/b' };

beforeEach(() => {
  context.libraryPath = '/pioneer/master.db';
  Object.values(context).forEach((v) => typeof v === 'function' && (v as any).mockReset?.());
  useSettingsStore.setState({ navidromeDestination: '', rekordboxDbKey: 'the-key' });
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

    fireEvent.click(screen.getByRole('button', { name: /Import into rekordbox/ }));
    await waitFor(() => expect(api().navidromeImport).toHaveBeenCalledWith(expect.objectContaining({
      libraryPath: '/pioneer/master.db', dbKey: 'the-key', destination: '/Users/dj/Music/Navidrome', playlistIds: ['p1'], songIds: ['s1'],
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
    fireEvent.click(screen.getByRole('button', { name: /Import into rekordbox/ }));
    await waitFor(() => expect(context.showNotification).toHaveBeenCalledWith('error', expect.stringMatching(/Close rekordbox first/)));
    expect(api().navidromeImport).not.toHaveBeenCalled();
  });

  it('says a cancelled import added nothing', async () => {
    api().navidromeImport = vi.fn(async () => ({ success: true, data: { ...summary, cancelled: true, tracksAdded: 0, playlists: [] } }));
    render(<NavidromePage />);
    fireEvent.click(await screen.findByLabelText('Peak'));
    fireEvent.click(screen.getByRole('button', { name: /Import into rekordbox/ }));
    expect(await screen.findByText(/Cancelled — nothing was added to rekordbox/)).toBeTruthy();
  });
});
