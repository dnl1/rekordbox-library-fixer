import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { AboutModal } from '../../src/renderer/components/ui/AboutModal';

const api = () => (window as any).electronAPI;

beforeEach(() => {
  api().getAppVersion = vi.fn(async () => ({ success: true, data: { version: '0.7.0-beta.7' } }));
  api().openExternal = vi.fn(async () => ({ success: true }));
});

describe('AboutModal', () => {
  it('keeps the original credit and says this build is a fork', () => {
    render(<AboutModal isOpen onClose={() => undefined} />);
    // The licence forbids removing the attribution, and asks for a modified version to say so.
    expect(screen.getByText('Koray Sels')).toBeTruthy();
    expect(screen.getByText(/© 2025 Koray Sels/)).toBeTruthy();
    expect(screen.getByText(/This version is a fork maintained by/)).toBeTruthy();
    expect(screen.getByText('dnl1')).toBeTruthy();
  });

  it('links to the original repository and to the fork', async () => {
    render(<AboutModal isOpen onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /View on GitHub/ }));
    fireEvent.click(screen.getByRole('button', { name: /dnl1's fork on GitHub/ }));
    await waitFor(() => expect(api().openExternal).toHaveBeenCalledTimes(2));
    expect(api().openExternal).toHaveBeenNthCalledWith(1, 'https://github.com/koraysels/rekordbox-library-fixer');
    expect(api().openExternal).toHaveBeenNthCalledWith(2, 'https://github.com/dnl1/rekordbox-library-fixer');
  });
});
