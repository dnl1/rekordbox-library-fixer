import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

const context = {
  libraryData: null as any,
  libraryPath: '',
  showNotification: vi.fn(),
};
vi.mock('../../src/renderer/AppWithRouter', () => ({ useAppContext: () => context }));

import { ExportPlaylistZipPanel } from '../../src/renderer/components/maintenance/ExportPlaylistZipPanel';
import { resetPlaylistZipSession } from '../../src/renderer/export/playlistZipSession';

const api = () => (window as any).electronAPI;

beforeEach(() => {
  resetPlaylistZipSession();
  context.showNotification = vi.fn();
  context.libraryData = {
    tracks: new Map([
      ['1', { id: '1', name: 'One', artist: 'A', location: '/m/one.mp3', cues: [{ big: 'payload' }] }],
      ['2', { id: '2', name: 'Two', artist: 'B', location: '/m/two.aiff' }],
    ]),
    playlists: [{ name: 'Friday', type: 'PLAYLIST', tracks: ['2', '1'] }],
  };
  api().onPlaylistZipProgress = vi.fn(() => () => undefined);
  api().playlistZipPreview = vi.fn(async () => ({
    success: true, data: { files: 2, totalSizeBytes: 2_000_000, skipped: [] },
  }));
  api().choosePlaylistZipPath = vi.fn(async () => ({ success: true, data: { filePath: '/out/Friday.zip' } }));
  api().exportPlaylistZip = vi.fn(async () => ({
    success: true, data: { outputPath: '/out/Friday.zip', filesAdded: 2, bytes: 2_000_000, skipped: [], cancelled: false },
  }));
});

const choose = () => fireEvent.change(screen.getByLabelText('Playlist'), { target: { value: '0' } });

describe('ExportPlaylistZipPanel', () => {
  it('waits for a playlist before it offers to export', () => {
    render(<ExportPlaylistZipPanel />);
    expect((screen.getByRole('button', { name: /Export ZIP/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says what the zip will hold once a playlist is chosen', async () => {
    render(<ExportPlaylistZipPanel />);
    choose();
    await waitFor(() => expect(screen.getByText(/2 files/)).toBeTruthy());
  });

  it('sends the playlist’s tracks in its order, and only what the export needs', async () => {
    render(<ExportPlaylistZipPanel />);
    choose();
    await screen.findByText(/2 files/);
    fireEvent.click(screen.getByRole('button', { name: /Export ZIP/ }));
    await waitFor(() => expect(api().exportPlaylistZip).toHaveBeenCalled());
    expect(api().choosePlaylistZipPath).toHaveBeenCalledWith('Friday');
    const request = api().exportPlaylistZip.mock.calls[0][0];
    expect(request.tracks).toEqual([
      { id: '2', name: 'Two', artist: 'B', location: '/m/two.aiff' },
      { id: '1', name: 'One', artist: 'A', location: '/m/one.mp3' },
    ]);
    expect(request.outputPath).toBe('/out/Friday.zip');
    await waitFor(() => expect(screen.getByRole('button', { name: /Show in folder/ })).toBeTruthy());
  });

  it('does nothing when the save dialog is cancelled', async () => {
    api().choosePlaylistZipPath = vi.fn(async () => ({ success: true, data: { filePath: null } }));
    render(<ExportPlaylistZipPanel />);
    choose();
    await screen.findByText(/2 files/);
    fireEvent.click(screen.getByRole('button', { name: /Export ZIP/ }));
    await waitFor(() => expect(api().choosePlaylistZipPath).toHaveBeenCalled());
    expect(api().exportPlaylistZip).not.toHaveBeenCalled();
  });
});
