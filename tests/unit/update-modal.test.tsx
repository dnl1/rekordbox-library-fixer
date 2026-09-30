import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { UpdateModal } from '../../src/renderer/components/ui/UpdateModal';
import { openUpdateDialog, resetUpdateSession, checkForUpdates } from '../../src/renderer/updates/updateSession';

const api = () => (window as any).electronAPI;

const available = {
  currentVersion: '0.7.0-beta.4',
  available: true,
  latest: {
    version: '0.7.0-beta.5', name: 'v0.7.0-beta.5 — something new', prerelease: true,
    notes: 'What changed\n\n---\n\n## macOS – Which file to download', url: 'https://github.com/dnl1/r/releases/tag/v0.7.0-beta.5',
  },
  install: 'installer',
  assetName: 'Setup.exe',
  assetSize: 1000,
};

beforeEach(() => {
  resetUpdateSession();
  api().checkForUpdates = vi.fn(async () => ({ success: true, data: available }));
  api().installUpdate = vi.fn(async () => ({ success: true, data: { mode: 'installer', quitting: true } }));
  api().onUpdateDownloadProgress = vi.fn(() => () => undefined);
  api().openExternal = vi.fn(async () => ({ success: true }));
});

describe('UpdateModal', () => {
  it('checks when opened from the menu, and shows the release’s own notes only', async () => {
    render(<UpdateModal />);
    act(() => openUpdateDialog());
    await waitFor(() => expect(screen.getByText(/Version 0.7.0-beta.5 is available/)).toBeTruthy());
    expect(api().checkForUpdates).toHaveBeenCalledTimes(1);
    expect(screen.getByText('What changed')).toBeTruthy();
    expect(screen.queryByText(/Which file to download/)).toBeNull();
  });

  it('downloads and installs, then says the app is restarting', async () => {
    render(<UpdateModal />);
    act(() => openUpdateDialog());
    fireEvent.click(await screen.findByRole('button', { name: /Download and install/ }));
    await waitFor(() => expect(screen.getByText(/closes now and opens again/)).toBeTruthy());
    expect(api().installUpdate).toHaveBeenCalled();
  });

  it('offers only the release page when this build cannot install', async () => {
    api().checkForUpdates = vi.fn(async () => ({ success: true, data: { ...available, install: 'manual' } }));
    render(<UpdateModal />);
    act(() => openUpdateDialog());
    await screen.findByText(/cannot install the update itself/);
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Release page/ }));
    expect(api().openExternal).toHaveBeenCalledWith(available.latest.url);
  });

  it('keeps a failed start-up check quiet', async () => {
    api().checkForUpdates = vi.fn(async () => ({ success: false, error: 'offline' }));
    await checkForUpdates({ silent: true });
    render(<UpdateModal />);
    act(() => openUpdateDialog());
    // Opening the dialog checks again, and that one does report.
    await waitFor(() => expect(screen.getByText('offline')).toBeTruthy());
  });
});
