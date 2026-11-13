import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

const context = {
  libraryData: null as any,
  libraryPath: '',
  showNotification: vi.fn(),
};
vi.mock('../../src/renderer/AppWithRouter', () => ({ useAppContext: () => context }));

import { CleanupOriginalsPanel } from '../../src/renderer/components/maintenance/CleanupOriginalsPanel';
import { resetCleanupSession } from '../../src/renderer/conversion/originalsCleanupSession';

const api = () => (window as any).electronAPI;

beforeEach(() => {
  resetCleanupSession();
  context.libraryData = { tracks: new Map([['1', { id: '1', name: 'T', artist: 'A', location: '/m/a.aiff' }]]), playlists: [] };
  context.libraryPath = '/pioneer/master.db';
  api().onCleanupOriginalsProgress = vi.fn(() => () => undefined);
  api().cleanupOriginalsPreview = vi.fn(async () => ({
    success: true, data: { available: true, files: 3, filesByKind: { flac: 2, wav: 0, m4a: 1 }, totalSizeBytes: 3_000_000, stillUsed: 2 },
  }));
  api().cleanupOriginals = vi.fn(async () => ({
    success: true, data: { trashed: ['/m/a.flac'], freedBytes: 1000, kept: [], failed: [], cancelled: false },
  }));
});

describe('CleanupOriginalsPanel', () => {
  it('is for rekordbox’s database only', () => {
    context.libraryPath = '/x/collection.xml';
    render(<CleanupOriginalsPanel />);
    expect(screen.getByText(/Only for rekordbox.s own database/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Find leftover originals/ })).toBeNull();
  });

  it('finds the leftovers, points at Convert for the ones still in use, and asks before trashing', async () => {
    render(<CleanupOriginalsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Find leftover originals/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Check and trash 3 originals/ })).toBeTruthy());
    expect(screen.getByText(/2 more still have an entry pointing at them/)).toBeTruthy();
    expect(screen.getByText(/3 originals beside a conversion no entry uses \(2 FLAC, 1 M4A\)/)).toBeTruthy();
    expect(api().cleanupOriginals).not.toHaveBeenCalled();
  });

  it('sends the whole library and the key, and reports what was freed', async () => {
    render(<CleanupOriginalsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Find leftover originals/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Check and trash 3 originals/ }));
    await waitFor(() => expect(screen.getByText(/1 trashed/)).toBeTruthy());
    expect(api().cleanupOriginals).toHaveBeenCalledWith(expect.objectContaining({
      libraryPath: '/pioneer/master.db',
      tracks: [expect.objectContaining({ location: '/m/a.aiff' })],
    }));
  });

  it('offers nothing to press when there is nothing to clean up', async () => {
    api().cleanupOriginalsPreview = vi.fn(async () => ({
      success: true, data: { available: true, files: 0, filesByKind: { flac: 0, wav: 0, m4a: 0 }, totalSizeBytes: 0, stillUsed: 0 },
    }));
    render(<CleanupOriginalsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Find leftover originals/ }));
    await waitFor(() => expect(screen.getByText(/Nothing to clean up/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Check and trash/ })).toBeNull();
  });
});
