import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { SettingsPanel } from '../../src/renderer/components/SettingsPanel';
import type { ScanOptions } from '../../src/renderer/types';

const scanOptions: ScanOptions = {
  useFingerprint: true, useMetadata: false, metadataFields: ['artist', 'title', 'duration'],
  pathPreferences: [], preferLossless: false,
};

describe('SettingsPanel', () => {
  it('writes a change still waiting in its timer when it unmounts', () => {
    // In Settings the panel unmounts as soon as another section or page is
    // opened; the half-second debounce used to drop the last change then.
    vi.useFakeTimers();
    try {
      const setScanOptions = vi.fn();
      const { unmount } = render(
        <SettingsPanel
          scanOptions={scanOptions}
          setScanOptions={setScanOptions}
          resolutionStrategy="keep-highest-quality"
          setResolutionStrategy={vi.fn()}
        />
      );
      fireEvent.click(screen.getByText('Audio Fingerprinting'));
      expect(setScanOptions).not.toHaveBeenCalled();
      unmount();
      expect(setScanOptions).toHaveBeenCalledWith(expect.objectContaining({ useFingerprint: false }));
    } finally {
      vi.useRealTimers();
    }
  });
});
