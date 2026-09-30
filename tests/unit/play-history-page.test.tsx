import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

const context = { libraryPath: '' };
vi.mock('../../src/renderer/AppWithRouter', () => ({ useAppContext: () => context }));

import { PlayHistoryPage } from '../../src/renderer/components/pages/PlayHistoryPage';
import { useSettingsStore } from '../../src/renderer/stores/settingsStore';

const api = () => (window as any).electronAPI;

const track = (trackNo: number, artist: string, title: string, inCollection = true) => ({
  trackNo, contentId: `c${trackNo}`, playedAt: `2026-09-27T21:${String(trackNo).padStart(2, '0')}:00.000Z`,
  title: inCollection ? title : '', artist: inCollection ? artist : '', location: `/m/${trackNo}.mp3`, inCollection,
});

const sessions = [
  {
    id: 's2', name: 'HISTORY 2026-09-27 (1)', createdAt: '2026-09-27T21:17:00.000Z',
    tracks: [track(1, 'Victor Ruiz', 'The Ritual'), track(2, '', '', false), track(3, 'Avalon', 'Explorers')],
  },
  {
    id: 's1', name: 'HISTORY 2026-09-27', createdAt: '2026-09-27T21:04:00.000Z',
    tracks: [track(1, 'Avalon', 'Dusk Till Dawn')],
  },
  { id: 's0', name: 'HISTORY 2026-09-20', createdAt: '2026-09-20T23:00:00.000Z', tracks: [] },
];

beforeEach(() => {
  context.libraryPath = '/pioneer/master.db';
  useSettingsStore.getState().setRekordboxDbKey('the-key');
  api().readPlayHistory = vi.fn(async () => ({ success: true, data: sessions }));
});

describe('PlayHistoryPage', () => {
  it('asks for rekordbox’s database when an XML is open, and reads nothing', () => {
    context.libraryPath = '/x/collection.xml';
    render(<PlayHistoryPage />);
    expect(screen.getByText(/read from rekordbox.s own database/)).toBeTruthy();
    expect(api().readPlayHistory).not.toHaveBeenCalled();
  });

  it('reads the open database with the saved key', async () => {
    render(<PlayHistoryPage />);
    await waitFor(() => expect(api().readPlayHistory).toHaveBeenCalledWith({ libraryPath: '/pioneer/master.db', dbKey: 'the-key' }));
    expect(await screen.findByText('3 sessions · 4 tracks played')).toBeTruthy();
  });

  it('opens the latest set, in order, and marks a track the collection lost', async () => {
    render(<PlayHistoryPage />);
    expect(await screen.findByText('Victor Ruiz — The Ritual')).toBeTruthy();
    expect(screen.getByText('Avalon — Explorers')).toBeTruthy();
    expect(screen.getByText('No longer in the collection')).toBeTruthy();
    // The earlier session stays closed until asked for.
    expect(screen.queryByText('Avalon — Dusk Till Dawn')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /HISTORY 2026-09-27(?! \(1\))/ }));
    expect(screen.getByText('Avalon — Dusk Till Dawn')).toBeTruthy();
  });

  it('says so when a session played nothing', async () => {
    render(<PlayHistoryPage />);
    fireEvent.click(await screen.findByRole('button', { name: /HISTORY 2026-09-20/ }));
    expect(screen.getByText('Nothing was played in this session.')).toBeTruthy();
  });

  it('finds every session a track was played in', async () => {
    render(<PlayHistoryPage />);
    await screen.findByText('Victor Ruiz — The Ritual');
    fireEvent.change(screen.getByPlaceholderText(/Search artist or track/), { target: { value: 'avalon' } });
    expect(screen.getByText('Avalon — Explorers')).toBeTruthy();
    expect(screen.getByText('Avalon — Dusk Till Dawn')).toBeTruthy();
    expect(screen.queryByText('Victor Ruiz — The Ritual')).toBeNull();
    expect(screen.queryByRole('button', { name: /HISTORY 2026-09-20/ })).toBeNull();
  });

  it('shows why the history could not be read', async () => {
    api().readPlayHistory = vi.fn(async () => ({ success: false, error: 'Could not decrypt the database — check the key.' }));
    render(<PlayHistoryPage />);
    expect(await screen.findByText('Could not decrypt the database — check the key.')).toBeTruthy();
  });

  it('reads again on Refresh, for a set rekordbox is still recording', async () => {
    render(<PlayHistoryPage />);
    await screen.findByText('Victor Ruiz — The Ritual');
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(api().readPlayHistory).toHaveBeenCalledTimes(2));
  });
});
