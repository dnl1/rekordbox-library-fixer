import { describe, it, expect } from 'vitest';
import { recoverDbKey, pythonCandidates, PYREKORDBOX_KEY_ONE_LINER, type Runner } from '../../src/main/dbKeyRecovery';
import { keyCommandFor } from '../../src/renderer/utils/keyExtractionCommand';

const KEY = '0123456789abcdef'.repeat(4);

/** A machine described by what each command answers. */
const machine = (answers: Record<string, { code: number; stdout?: string; stderr?: string }>) => {
  const calls: string[] = [];
  const run: Runner = async (command, args) => {
    const line = `${command} ${args.join(' ')}`;
    calls.push(line);
    const match = Object.entries(answers).find(([prefix]) => line.startsWith(prefix));
    const a = match?.[1] ?? { code: 1, stderr: 'not found' };
    return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' };
  };
  return { run, calls };
};

describe('recoverDbKey', () => {
  it('asks pyrekordbox for the key when it is already installed', async () => {
    const { run, calls } = machine({
      'py --version': { code: 0, stdout: 'Python 3.13.5' },
      'py -c import pyrekordbox': { code: 0 },
      'py -c from pyrekordbox': { code: 0, stdout: `${KEY}\n` },
    });
    expect(await recoverDbKey('win32', run)).toEqual({ ok: true, key: KEY, python: 'py', installed: false });
    expect(calls.some((c) => c.includes('pip install'))).toBe(false);
  });

  it('installs pyrekordbox for the user first when it is missing', async () => {
    const { run, calls } = machine({
      'python3 --version': { code: 0, stdout: 'Python 3.12.3' },
      'python3 -c import pyrekordbox': { code: 1, stderr: 'ModuleNotFoundError' },
      'python3 -m pip install --quiet --user pyrekordbox': { code: 0 },
      'python3 -c from pyrekordbox': { code: 0, stdout: KEY.toUpperCase() },
    });
    expect(await recoverDbKey('darwin', run)).toMatchObject({ ok: true, key: KEY, installed: true });
    expect(calls).toContain('python3 -m pip install --quiet --user pyrekordbox');
  });

  it('skips a Python that is not Python 3 — the Store alias on Windows, for one', async () => {
    const { run } = machine({
      'py --version': { code: 9009, stderr: 'Python was not found; run without arguments to install from the Microsoft Store' },
      'python --version': { code: 0, stdout: 'Python 3.11.0' },
      'python -c import pyrekordbox': { code: 0 },
      'python -c from pyrekordbox': { code: 0, stdout: KEY },
    });
    expect(await recoverDbKey('win32', run)).toMatchObject({ ok: true, python: 'python' });
  });

  it('says Python is missing rather than failing obscurely', async () => {
    const { run } = machine({});
    expect(await recoverDbKey('win32', run)).toMatchObject({ ok: false, reason: 'no-python' });
  });

  it('reports why the install failed', async () => {
    const { run } = machine({
      'python3 --version': { code: 0, stdout: 'Python 3.12.3' },
      'python3 -c import pyrekordbox': { code: 1 },
      'python3 -m pip': { code: 1, stderr: 'noise\nerror: externally-managed-environment' },
    });
    expect(await recoverDbKey('linux', run)).toEqual({
      ok: false, reason: 'install-failed',
      detail: 'pyrekordbox could not be installed: error: externally-managed-environment',
    });
  });

  it('refuses anything that is not 64 hexadecimal characters', async () => {
    const { run } = machine({
      'py --version': { code: 0, stdout: 'Python 3.13.5' },
      'py -c import pyrekordbox': { code: 0 },
      'py -c from pyrekordbox': { code: 0, stdout: 'DeprecationWarning: something' },
    });
    expect(await recoverDbKey('win32', run)).toMatchObject({ ok: false, reason: 'no-key' });
  });
});

describe('the one-liner', () => {
  it('is the command the load screen shows', () => {
    // Two copies — the main process runs it, the renderer displays it — must not drift.
    expect(keyCommandFor('windows').command).toContain(PYREKORDBOX_KEY_ONE_LINER);
    expect(keyCommandFor('linux').command).toContain(PYREKORDBOX_KEY_ONE_LINER);
  });

  it('tries the py launcher first on Windows', () => {
    expect(pythonCandidates('win32')[0]).toBe('py');
    expect(pythonCandidates('darwin')[0]).toBe('python3');
  });
});
