import { describe, it, expect } from 'vitest';
import { keeperProblem } from '../../src/main/keeperGuard';

const onDisk = (files: string[]) => (p: string) => files.includes(p);

describe('keeperProblem', () => {
  it('lets the merge through when the kept copy has its file', () => {
    expect(keeperProblem('/SSD/a.aiff', ['/Mac/a.mp3'], onDisk(['/SSD/a.aiff', '/Mac/a.mp3']))).toBeNull();
  });

  it('refuses when the kept file is missing but a retired copy still has audio', () => {
    // The consolidate drive is unplugged: keeping its copy would trash the only file.
    const reason = keeperProblem('/SSD/a.aiff', ['/Mac/a.mp3'], onDisk(['/Mac/a.mp3']));
    expect(reason).toMatch(/kept copy's file is missing/);
    expect(reason).toContain('/Mac/a.mp3');
  });

  it('lets entries merge when no copy has a file, since nothing can be lost', () => {
    expect(keeperProblem('/SSD/a.aiff', ['/Mac/a.mp3', undefined], onDisk([]))).toBeNull();
  });
});
