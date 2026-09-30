import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { SettingsLayout } from '../../src/renderer/components/settings/SettingsLayout';
import { parseSettingsSection, SETTINGS_SECTIONS } from '../../src/renderer/settings/sections';
import { useSettingsStore } from '../../src/renderer/stores/settingsStore';
import { DEFAULT_WORKERS } from '../../src/main/workerPool';

beforeEach(() => { useSettingsStore.setState({ workers: DEFAULT_WORKERS }); });

const menu = () => within(screen.getByRole('navigation', { name: 'Settings sections' }));

describe('SettingsLayout', () => {
  it('lists every section in the menu on the left, the open one marked', () => {
    render(<SettingsLayout section="duplicates" onSelect={vi.fn()} />);
    const items = menu().getAllByRole('button').map((b) => b.textContent);
    expect(items).toEqual(['Duplicate Detection', 'Track Relocation', 'Performance']);
    expect(menu().getByRole('button', { name: 'Duplicate Detection' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows the duplicate detection settings', () => {
    render(<SettingsLayout section="duplicates" onSelect={vi.fn()} />);
    expect(screen.getByText('Audio Fingerprinting')).toBeTruthy();
  });

  it('shows the relocator search settings', () => {
    render(<SettingsLayout section="relocation" onSelect={vi.fn()} />);
    expect(screen.getByText('Search Configuration')).toBeTruthy();
  });

  it('holds the worker count under Performance', () => {
    render(<SettingsLayout section="performance" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Workers: 4/), { target: { value: '6' } });
    expect(useSettingsStore.getState().workers).toBe(6);
  });

  it('asks for the section chosen in the menu', () => {
    const onSelect = vi.fn();
    render(<SettingsLayout section="duplicates" onSelect={onSelect} />);
    fireEvent.click(menu().getByRole('button', { name: 'Performance' }));
    expect(onSelect).toHaveBeenCalledWith('performance');
  });
});

describe('parseSettingsSection', () => {
  it('accepts the sections there are, and nothing else', () => {
    for (const section of SETTINGS_SECTIONS) { expect(parseSettingsSection(section)).toBe(section); }
    expect(parseSettingsSection('maintenance')).toBeUndefined();
    expect(parseSettingsSection(undefined)).toBeUndefined();
    expect(parseSettingsSection(3)).toBeUndefined();
  });
});
