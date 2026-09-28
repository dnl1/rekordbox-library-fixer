import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import React from 'react';

vi.mock('../../src/renderer/db/duplicationHistoryDb', () => ({ duplicationHistoryStorage: { record: vi.fn() } }));

import DuplicateItem from '../../src/renderer/components/DuplicateItem';
import { useDuplicateResolution } from '../../src/renderer/hooks/useDuplicateResolution';
import { useKeeperChoiceStore } from '../../src/renderer/stores/keeperChoiceStore';
import { keeperOfSet } from '../../src/renderer/utils/keeperOfSet';

const set = {
  id: 's1',
  matchType: 'metadata',
  confidence: 90,
  tracks: [
    { id: 'aiff', name: 'Takata', artist: 'X', location: '/Music/Takata.aiff', bitrate: 1411, size: 60_000_000, duration: 351 },
    { id: 'mp3', name: 'Takata', artist: 'X', location: '/Beatport/Takata.mp3', bitrate: 320, size: 14_000_000, duration: 351 },
  ],
};

const api = () => (window as any).electronAPI;

beforeEach(() => {
  useKeeperChoiceStore.setState({ chosen: {} });
  api().isRekordboxRunning = vi.fn(async () => ({ running: false }));
  api().mergeDuplicatesInDb = vi.fn(async () => ({ success: true, entriesRemoved: 1, playlistLinksMoved: 0, skipped: [] }));
});

describe('keeperOfSet', () => {
  it('keeps the chosen copy, else the recommended one, else none', () => {
    const [a, b] = set.tracks;
    expect(keeperOfSet(set.tracks, a, 'mp3')).toBe(b);
    expect(keeperOfSet(set.tracks, a, 'gone')).toBe(a);
    expect(keeperOfSet(set.tracks, null, undefined)).toBeNull();
  });
});

describe('choosing the copy to keep', () => {
  const renderItem = (strategy = 'keep-highest-quality') => {
    render(<DuplicateItem duplicate={set} isSelected={false} onToggleSelection={vi.fn()} resolutionStrategy={strategy} />);
    fireEvent.click(screen.getAllByRole('button').find((b) => !b.textContent)!); // expand
  };

  it('offers "Keep this" on the other copy whatever the strategy, and marks it as your choice', () => {
    renderItem();
    expect(screen.getByText('Will be kept')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep this' }));
    expect(useKeeperChoiceStore.getState().chosen).toEqual({ s1: 'mp3' });
    expect(screen.getByText(/Will be kept · your choice/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use recommended' }));
    expect(useKeeperChoiceStore.getState().chosen).toEqual({});
  });

  it('with the manual strategy, asks for a pick rather than keeping the first copy', () => {
    renderItem('manual');
    expect(screen.getAllByText('Pick the copy to keep')).toHaveLength(2);
  });

  const hook = (strategy: string, notify = vi.fn()) => renderHook(() => useDuplicateResolution({
    duplicates: [set], libraryData: null, setLibraryData: vi.fn(), selectedDuplicates: new Set(['s1']),
    resolutionStrategy: strategy, scanOptions: { preferLossless: false }, libraryPath: '/pioneer/master.db',
    deleteFromDisk: false, showNotification: notify, setDuplicates: vi.fn(), setSelections: vi.fn(),
    setIsScanning: vi.fn(), clearAll: vi.fn(), setPendingDeletePaths: vi.fn(),
  }));

  it('sends the chosen copy as the one to keep', async () => {
    useKeeperChoiceStore.getState().choose('s1', 'mp3');
    const { result } = hook('keep-highest-quality');
    await act(async () => { await result.current.resolveDuplicates(); });
    expect(api().mergeDuplicatesInDb.mock.calls[0][0].plans).toEqual([{ keepId: 'mp3', removeIds: ['aiff'] }]);
  });

  it('refuses a manual set with nothing picked', async () => {
    const notify = vi.fn();
    const { result } = hook('manual', notify);
    await act(async () => { await result.current.resolveDuplicates(); });
    expect(api().mergeDuplicatesInDb).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('error', expect.stringMatching(/Pick the copy to keep in 1 set/));
  });
});
