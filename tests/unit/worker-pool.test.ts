import { describe, it, expect } from 'vitest';
import { runPool, clampWorkers } from '../../src/main/workerPool';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('runPool', () => {
  it('runs no more than the given number at once, and keeps the results in order', async () => {
    let running = 0;
    let most = 0;
    const out = await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++; most = Math.max(most, running);
      await tick();
      running--;
      return n * 10;
    }, { cancelled: false });
    expect(most).toBe(3);
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it('says how many are running as that changes', async () => {
    const seen: number[] = [];
    await runPool([1, 2, 3], 2, async () => { await tick(); }, { cancelled: false }, (n) => seen.push(n));
    expect(Math.max(...seen)).toBe(2);
    expect(seen[seen.length - 1]).toBe(0);
  });

  it('starts nothing new once cancelled', async () => {
    const token = { cancelled: false };
    const seen: number[] = [];
    await runPool([1, 2, 3, 4], 1, async (n) => { seen.push(n); if (n === 2) { token.cancelled = true; } }, token);
    expect(seen).toEqual([1, 2]);
  });
});

describe('clampWorkers', () => {
  it('keeps the count between 1 and 8, whole, and 4 when there is none', () => {
    expect([1, -3, 2.7, 99, NaN, undefined].map((n) => clampWorkers(n as number))).toEqual([1, 1, 2, 8, 4, 4]);
  });
});
