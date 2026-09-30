import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { NavidromeSettings } from '../../src/renderer/components/settings/NavidromeSettings';

const api = () => (window as any).electronAPI;

beforeEach(() => {
  api().navidromeConnection = vi.fn(async () => ({ success: true, data: null }));
  api().navidromeSaveConnection = vi.fn(async () => ({ success: true, data: { apiVersion: '1.16.1', serverVersion: '0.53.3' } }));
  api().navidromeForgetConnection = vi.fn(async () => ({ success: true }));
});

const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('NavidromeSettings', () => {
  it('tests the connection before saving it, and says it worked', async () => {
    render(<NavidromeSettings />);
    type(/Server address/, 'https://music.example.com');
    type(/Username/, 'dj');
    type(/Password/, 'sesame');
    fireEvent.click(screen.getByRole('button', { name: 'Test and save' }));
    await waitFor(() => expect(screen.getByText(/Connected — Navidrome 0.53.3/)).toBeTruthy());
    expect(api().navidromeSaveConnection).toHaveBeenCalledWith({ url: 'https://music.example.com', username: 'dj', password: 'sesame' });
    // The field is cleared: the password is not kept in the page.
    expect((screen.getByLabelText(/Password/) as HTMLInputElement).value).toBe('');
  });

  it('shows what the server said when it refuses', async () => {
    api().navidromeSaveConnection = vi.fn(async () => ({ success: false, error: 'Wrong username or password.' }));
    render(<NavidromeSettings />);
    type(/Server address/, 'https://music.example.com');
    type(/Username/, 'dj');
    type(/Password/, 'nope');
    fireEvent.click(screen.getByRole('button', { name: 'Test and save' }));
    expect(await screen.findByText(/Wrong username or password/)).toBeTruthy();
  });

  it('fills in a saved connection without its password, and keeps it when left empty', async () => {
    api().navidromeConnection = vi.fn(async () => ({ success: true, data: { url: 'https://music.example.com', username: 'dj', hasPassword: true } }));
    render(<NavidromeSettings />);
    await waitFor(() => expect((screen.getByLabelText(/Server address/) as HTMLInputElement).value).toBe('https://music.example.com'));
    expect((screen.getByLabelText(/Password/) as HTMLInputElement).placeholder).toMatch(/leave empty to keep it/);
    fireEvent.click(screen.getByRole('button', { name: 'Test and save' }));
    await waitFor(() => expect(api().navidromeSaveConnection).toHaveBeenCalledWith({ url: 'https://music.example.com', username: 'dj', password: '' }));
  });

  it('forgets the server', async () => {
    api().navidromeConnection = vi.fn(async () => ({ success: true, data: { url: 'https://music.example.com', username: 'dj', hasPassword: true } }));
    render(<NavidromeSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(api().navidromeForgetConnection).toHaveBeenCalled());
    expect((screen.getByLabelText(/Server address/) as HTMLInputElement).value).toBe('');
  });
});
