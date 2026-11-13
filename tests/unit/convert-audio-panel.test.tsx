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

import { ConvertAudioPanel } from '../../src/renderer/components/maintenance/ConvertAudioPanel';
import { resetConversionSession } from '../../src/renderer/conversion/convertAudioSession';

const library = (locations: string[]) => ({
  tracks: new Map(locations.map((location, i) => [String(i), { id: String(i), name: 'T', artist: 'A', location }])),
  playlists: [],
});

const api = () => (window as any).electronAPI;

beforeEach(() => {
  resetConversionSession();
  context.libraryData = library(['/m/a.flac', '/m/b.mp3']);
  context.libraryPath = '/pioneer/master.db';
  api().onConvertAudioProgress = vi.fn(() => () => undefined);
  api().convertAudioPreview = vi.fn(async () => ({
    success: true,
    data: { available: true, sourceTracks: 1, files: 1, filesByKind: { flac: 1, wav: 0, m4a: 0 }, reusable: 0, missing: 0, conflicts: 0, totalSizeBytes: 1000 },
  }));
});

describe('ConvertAudioPanel', () => {
  it('asks for a library before it offers to do anything', () => {
    context.libraryData = null;
    render(<ConvertAudioPanel />);
    expect(screen.getByText(/Load a library first to convert/)).toBeTruthy();
  });

  it('converts FLAC, WAV and M4A unless told otherwise', () => {
    render(<ConvertAudioPanel />);
    for (const kind of ['FLAC', 'WAV', 'M4A']) {
      expect((screen.getByLabelText(kind) as HTMLInputElement).checked).toBe(true);
    }
  });

  it('never offers to convert a WAV to WAV', () => {
    render(<ConvertAudioPanel />);
    fireEvent.click(screen.getByLabelText(/^WAV\s*Uncompressed/));
    const wav = screen.getByLabelText('WAV') as HTMLInputElement;
    expect(wav.checked).toBe(false);
    expect(wav.disabled).toBe(true);
  });

  it('sends only the kinds still ticked', async () => {
    render(<ConvertAudioPanel />);
    fireEvent.click(screen.getByLabelText('M4A'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(api().convertAudioPreview).toHaveBeenCalled());
    expect(api().convertAudioPreview.mock.calls.at(-1)[0].sources).toEqual(['flac', 'wav']);
  });

  it('says how many of each kind it found', async () => {
    api().convertAudioPreview = vi.fn(async () => ({
      success: true,
      data: { available: true, sourceTracks: 4, files: 4, filesByKind: { flac: 2, wav: 0, m4a: 2 }, reusable: 0, missing: 0, conflicts: 0, totalSizeBytes: 0 },
    }));
    render(<ConvertAudioPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText(/4 files to convert \(2 FLAC, 2 M4A\)/)).toBeTruthy());
  });

  it('offers AIFF, WAV and MP3, with AIFF chosen', () => {
    render(<ConvertAudioPanel />);
    expect((screen.getByLabelText(/^AIFF/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByLabelText(/^WAV\s*Uncompressed/)).toBeTruthy();
    expect(screen.getByLabelText(/^MP3 320 kbps/)).toBeTruthy();
  });

  it('keeps the originals unless asked', () => {
    render(<ConvertAudioPanel />);
    expect((screen.getByLabelText(/Move the originals/) as HTMLInputElement).checked).toBe(false);
  });

  it('warns that trashing the FLAC after an MP3 conversion loses the lossless copy', () => {
    render(<ConvertAudioPanel />);
    fireEvent.click(screen.getByLabelText(/^MP3 320 kbps/));
    fireEvent.click(screen.getByLabelText(/Move the originals/));
    expect(screen.getByText(/the only lossless copy/)).toBeTruthy();
  });

  it('explains what converting an XML library can and cannot do', () => {
    context.libraryPath = '/x/collection.xml';
    render(<ConvertAudioPanel />);
    expect(screen.getByText(/adds the converted files as new/)).toBeTruthy();
  });

  it('previews by itself when Convert is pressed first', async () => {
    // Convert used to stay greyed out until Preview was pressed, which nothing said.
    render(<ConvertAudioPanel />);
    fireEvent.click(screen.getByRole('button', { name: /^Convert$/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Convert 1 files/ })).toBeTruthy());
    expect(api().convertAudioPreview).toHaveBeenCalledTimes(1);
  });

  it('says there is nothing to convert, and offers nothing to press', async () => {
    api().convertAudioPreview = vi.fn(async () => ({
      success: true,
      data: { available: true, sourceTracks: 2, files: 0, filesByKind: { flac: 0, wav: 0, m4a: 0 }, reusable: 0, missing: 0, conflicts: 2, totalSizeBytes: 0 },
    }));
    render(<ConvertAudioPanel />);
    fireEvent.click(screen.getByRole('button', { name: /^Convert$/ }));
    await waitFor(() => expect(screen.getByText('Nothing to convert here.')).toBeTruthy());
    expect((screen.getByRole('button', { name: /^Convert$/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says which files an earlier run already converted', async () => {
    api().convertAudioPreview = vi.fn(async () => ({
      success: true,
      data: { available: true, sourceTracks: 3, files: 3, filesByKind: { flac: 3, wav: 0, m4a: 0 }, reusable: 2, missing: 0, conflicts: 0, totalSizeBytes: 0 },
    }));
    render(<ConvertAudioPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText(/2 already have a \.aiff from an earlier run/)).toBeTruthy());
  });

  it('says so when this build has no ffmpeg, and offers nothing to press', async () => {
    api().convertAudioPreview = vi.fn(async () => ({
      success: true,
      data: { available: false, sourceTracks: 1, files: 1, filesByKind: { flac: 1, wav: 0, m4a: 0 }, reusable: 0, missing: 0, conflicts: 0, totalSizeBytes: 0 },
    }));
    render(<ConvertAudioPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText(/no ffmpeg for this platform/)).toBeTruthy());
    expect((screen.getByRole('button', { name: /^Convert$/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks for confirmation before converting', async () => {
    render(<ConvertAudioPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText(/1 file to convert \(1 FLAC\)/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Convert$/ }));
    expect(screen.getByText(/rekordbox must stay closed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Convert 1 files/ })).toBeTruthy();
  });

  it('keeps the result when the library reload unmounts it', async () => {
    // The write reloads the library, and the app replaces the whole page with
    // a spinner while it parses — the result used to vanish with the panel.
    api().isRekordboxRunning = vi.fn(async () => ({ running: false }));
    api().convertAudio = vi.fn(async () => ({
      success: true,
      data: {
        filesConverted: 1, tracksUpdated: 1, skipped: [], failed: [], cancelled: false,
        trashed: [], trashFailed: [], backupPath: '/pioneer/master.db.backup.x',
      },
    }));
    const first = render(<ConvertAudioPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText(/1 file to convert \(1 FLAC\)/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Convert$/ }));
    fireEvent.click(screen.getByRole('button', { name: /Convert 1 files/ }));
    first.unmount();

    await waitFor(() => expect(context.onLoadLibrary).toHaveBeenCalledWith('/pioneer/master.db'));
    render(<ConvertAudioPanel />);
    expect(screen.getByText('Complete')).toBeTruthy();
    expect(screen.getByText('1 entries updated')).toBeTruthy();
  });

  it('does not show another library\'s result', async () => {
    api().convertAudio = vi.fn(async () => ({
      success: true,
      data: { filesConverted: 1, tracksUpdated: 0, skipped: [], failed: [], cancelled: false, trashed: [], trashFailed: [] },
    }));
    const { startConversion } = await import('../../src/renderer/conversion/convertAudioSession');
    await startConversion({ tracks: [], libraryPath: '/other/master.db', format: 'aiff', trashOriginals: false });
    render(<ConvertAudioPanel />);
    expect(screen.queryByText('Complete')).toBeNull();
  });

  it('converts only the chosen playlist, while sending the whole library', async () => {
    // The whole library travels too: an original is trashed only if nothing else uses it.
    context.libraryData = { ...library(['/m/a.flac', '/m/b.flac']), playlists: [{ name: 'USB', type: 'PLAYLIST', tracks: ['1'] }] };
    render(<ConvertAudioPanel />);
    fireEvent.change(screen.getByLabelText('Convert'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(api().convertAudioPreview).toHaveBeenCalled());
    const sent = api().convertAudioPreview.mock.calls.at(-1)[0];
    expect(sent.scopeTrackIds).toEqual(['1']);
    expect(sent.tracks).toHaveLength(2);
  });

  it('does not offer the trash for an XML library', () => {
    // rekordbox's own database still points at the FLACs after an XML conversion.
    context.libraryPath = '/x/collection.xml';
    render(<ConvertAudioPanel />);
    const box = screen.getByLabelText(/Move the originals/) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    expect(screen.getByText(/after an XML conversion, rekordbox still/)).toBeTruthy();
  });

  it('offers the whole library by default', () => {
    context.libraryData = { ...library(['/m/a.flac']), playlists: [{ name: 'USB', type: 'PLAYLIST', tracks: ['0'] }] };
    render(<ConvertAudioPanel />);
    expect((screen.getByLabelText('Convert') as HTMLSelectElement).value).toBe('');
    expect(screen.getByRole('option', { name: 'Playlist: USB (1)' })).toBeTruthy();
  });
});
