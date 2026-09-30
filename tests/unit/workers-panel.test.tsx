import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { WorkersPanel } from '../../src/renderer/components/settings/WorkersPanel';
import { useSettingsStore } from '../../src/renderer/stores/settingsStore';
import { DEFAULT_WORKERS } from '../../src/main/workerPool';

beforeEach(() => { useSettingsStore.setState({ workers: DEFAULT_WORKERS }); });

describe('WorkersPanel', () => {
  it('starts at four workers and goes up to eight', () => {
    render(<WorkersPanel />);
    const slider = screen.getByLabelText(/Workers: 4/) as HTMLInputElement;
    expect(slider.min).toBe('1');
    expect(slider.max).toBe('8');
  });

  it('remembers what is chosen, and never more than eight', () => {
    render(<WorkersPanel />);
    fireEvent.change(screen.getByLabelText(/Workers/), { target: { value: '6' } });
    expect(useSettingsStore.getState().workers).toBe(6);
    useSettingsStore.getState().setWorkers(20);
    expect(useSettingsStore.getState().workers).toBe(8);
  });
});
