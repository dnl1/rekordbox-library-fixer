import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useSettingsStore } from '../../src/renderer/stores/settingsStore';
import React from 'react';
import { ConsolidatePanel } from '../../src/renderer/components/maintenance/ConsolidatePanel';
import { FilterMovePanel } from '../../src/renderer/components/maintenance/FilterMovePanel';

const tracks = [
  { id: '1', name: 'Song', artist: 'A', location: '/m/a.mp3' },
  { id: '2', name: 'Other', artist: 'B', location: '/m/b.mp3' },
] as any[];

const DEFAULT = '/Users/dj/Music/Rekordbox Library';

beforeEach(() => {
  (window as any).electronAPI.onConsolidateProgress = vi.fn(() => () => undefined);
  (window as any).electronAPI.onFilterProgress = vi.fn(() => () => undefined);
  (window as any).electronAPI.defaultConsolidateDestination = vi.fn(async () => ({ success: true, data: DEFAULT }));
  (window as any).electronAPI.consolidatePreview = vi.fn(async () => ({ success: true, data: { total: 2, conflicts: 0, missing: 0, totalSizeBytes: 0 } }));
  (window as any).electronAPI.consolidateLibrary = vi.fn(async () => ({ success: true, data: { succeeded: 2, skipped: 0, failed: 0, errors: [] } }));
  useSettingsStore.setState({ consolidateDestination: '' });
});

describe('ConsolidatePanel', () => {
  it('asks for a library before it offers to do anything', () => {
    render(<ConsolidatePanel tracks={[]} libraryPath="" hasLibrary={false} />);
    expect(screen.getByText(/Load a library first to consolidate/)).toBeTruthy();
  });

  it('offers a destination once a library is loaded', () => {
    render(<ConsolidatePanel tracks={tracks} libraryPath="/x/c.xml" hasLibrary />);
    expect(screen.getByLabelText('Destination folder')).toBeTruthy();
  });

  it('subscribes to progress while it is mounted', () => {
    const { unmount } = render(<ConsolidatePanel tracks={tracks} libraryPath="/x/c.xml" hasLibrary />);
    expect((window as any).electronAPI.onConsolidateProgress).toHaveBeenCalled();
    unmount();
  });
});

describe('FilterMovePanel', () => {
  it('asks for a library before it offers to do anything', () => {
    render(<FilterMovePanel tracks={[]} libraryPath="" hasLibrary={false} />);
    expect(screen.getByText(/Load a library first/)).toBeTruthy();
  });

  it('starts with one empty rule', () => {
    render(<FilterMovePanel tracks={tracks} libraryPath="/x/c.xml" hasLibrary />);
    expect(screen.getByText('Filters')).toBeTruthy();
    expect(screen.getByDisplayValue('Artist')).toBeTruthy();
  });

  it('keeps its own destination, separate from the consolidate one', () => {
    // The two tools shared a file and were told apart only by an "f" prefix on
    // every piece of state; they are separate components now.
    render(
      <>
        <ConsolidatePanel tracks={tracks} libraryPath="/x/c.xml" hasLibrary />
        <FilterMovePanel tracks={tracks} libraryPath="/x/c.xml" hasLibrary />
      </>
    );
    expect(screen.getAllByLabelText('Destination folder')).toHaveLength(2);
  });
});

describe('ConsolidatePanel destination', () => {
  const field = () => screen.getByLabelText('Destination folder') as HTMLInputElement;

  it('starts from a folder of its own in this computer\'s Music folder', async () => {
    render(<ConsolidatePanel tracks={tracks} libraryPath="/x/c.xml" hasLibrary />);
    await waitFor(() => expect(field().value).toBe(DEFAULT));
    expect(screen.getByText(/The default: a folder of its own in your Music folder/)).toBeTruthy();
  });

  it('keeps a folder chosen before over the default', async () => {
    useSettingsStore.setState({ consolidateDestination: '/Volumes/SSD/Music' });
    render(<ConsolidatePanel tracks={tracks} libraryPath="/x/c.xml" hasLibrary />);
    await waitFor(() => expect((window as any).electronAPI.defaultConsolidateDestination).toHaveBeenCalled());
    expect(field().value).toBe('/Volumes/SSD/Music');
    expect(screen.queryByText(/The default:/)).toBeNull();
  });

  it('falls back to the default when the field is emptied', async () => {
    useSettingsStore.setState({ consolidateDestination: '/Volumes/SSD/Music' });
    render(<ConsolidatePanel tracks={tracks} libraryPath="/x/c.xml" hasLibrary />);
    await waitFor(() => expect((window as any).electronAPI.defaultConsolidateDestination).toHaveBeenCalled());
    fireEvent.change(field(), { target: { value: '' } });
    await waitFor(() => expect(field().value).toBe(DEFAULT));
  });

  it('previews the default without remembering it', async () => {
    render(<ConsolidatePanel tracks={tracks} libraryPath="/x/c.xml" hasLibrary />);
    await waitFor(() => expect(field().value).toBe(DEFAULT));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect((window as any).electronAPI.consolidatePreview).toHaveBeenCalledWith({ tracks, destination: DEFAULT }));
    // Remembered, it would decide which copy of a duplicate is kept — before anything was consolidated there.
    expect(useSettingsStore.getState().consolidateDestination).toBe('');
  });

  it('consolidates into the default, and remembers it once it has been used', async () => {
    render(<ConsolidatePanel tracks={tracks} libraryPath="/x/c.xml" hasLibrary />);
    await waitFor(() => expect(field().value).toBe(DEFAULT));
    fireEvent.click(screen.getByRole('button', { name: /Copy Library/ }));
    await waitFor(() => expect((window as any).electronAPI.consolidateLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ destination: DEFAULT }) })
    ));
    expect(useSettingsStore.getState().consolidateDestination).toBe(DEFAULT);
  });
});
