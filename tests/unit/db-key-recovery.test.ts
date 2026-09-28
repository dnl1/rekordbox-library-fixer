import { describe, it, expect } from 'vitest';
import { recoverDbKey, pythonCandidates, venvPython, reasonFrom, PYREKORDBOX_KEY_ONE_LINER, type Runner } from '../../src/main/dbKeyRecovery';
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
      'python3 -m pip': { code: 1, stderr: 'error: externally-managed-environment\n\n× This environment is externally managed\n╰─> To install Python packages system-wide, try apt install' },
    });
    expect(await recoverDbKey('linux', run)).toEqual({
      ok: false, reason: 'install-failed',
      detail: 'pyrekordbox could not be installed — pip --user: error: externally-managed-environment',
    });
  });

  it('installs into a private environment where pip --user is refused', async () => {
    // Homebrew's Python and recent Debian/Ubuntu refuse --user installs outright.
    const VENV = '/data/pyrekordbox';
    const { run, calls } = machine({
      'python3 --version': { code: 0, stdout: 'Python 3.13.1' },
      'python3 -c import pyrekordbox': { code: 1 },
      [`${VENV}/bin/python -c import pyrekordbox`]: { code: 1 },
      [`python3 -m venv ${VENV}`]: { code: 0 },
      [`${VENV}/bin/python -m pip install --quiet pyrekordbox`]: { code: 0 },
      [`${VENV}/bin/python -c from pyrekordbox`]: { code: 0, stdout: KEY },
      'python3 -m pip install --quiet --user': { code: 1, stderr: 'error: externally-managed-environment' },
    });
    expect(await recoverDbKey('darwin', run, VENV)).toEqual({ ok: true, key: KEY, python: `${VENV}/bin/python`, installed: true });
    expect(calls.some((c) => c.includes('--user'))).toBe(false);
  });

  it('reuses the private environment next time, installing nothing', async () => {
    const VENV = '/data/pyrekordbox';
    const { run, calls } = machine({
      'python3 --version': { code: 0, stdout: 'Python 3.13.1' },
      'python3 -c import pyrekordbox': { code: 1 },
      [`${VENV}/bin/python -c import pyrekordbox`]: { code: 0 },
      [`${VENV}/bin/python -c from pyrekordbox`]: { code: 0, stdout: KEY },
    });
    expect(await recoverDbKey('linux', run, VENV)).toMatchObject({ ok: true, installed: false });
    expect(calls.some((c) => c.includes('install') || c.includes('-m venv'))).toBe(false);
  });

  it('falls back to pip --user where Python has no venv module', async () => {
    const VENV = '/data/pyrekordbox';
    const { run } = machine({
      'python3 --version': { code: 0, stdout: 'Python 3.12.3' },
      'python3 -c import pyrekordbox': { code: 1 },
      [`python3 -m venv ${VENV}`]: { code: 1, stderr: 'The virtual environment was not created successfully because ensurepip is not available.' },
      'python3 -m pip install --quiet --user pyrekordbox': { code: 0 },
      'python3 -c from pyrekordbox': { code: 0, stdout: KEY },
    });
    expect(await recoverDbKey('linux', run, VENV)).toMatchObject({ ok: true, python: 'python3', installed: true });
  });

  it('says what both installs said when neither works', async () => {
    const VENV = '/data/pyrekordbox';
    const { run } = machine({
      'python3 --version': { code: 0, stdout: 'Python 3.12.3' },
      'python3 -c import pyrekordbox': { code: 1 },
      [`python3 -m venv ${VENV}`]: { code: 1, stderr: 'ensurepip is not available' },
      'python3 -m pip': { code: 1, stderr: 'No module named pip' },
    });
    const outcome = await recoverDbKey('linux', run, VENV);
    expect(outcome).toMatchObject({ ok: false, reason: 'install-failed' });
    expect(outcome.ok === false && outcome.detail).toBe(
      'pyrekordbox could not be installed — a private environment: ensurepip is not available; pip --user: No module named pip'
    );
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

describe('reasonFrom', () => {
  it('picks the line that says why, not the one naming the command', () => {
    const venv = 'The virtual environment was not created successfully because ensurepip is not\n'
      + 'available.  On Debian/Ubuntu systems, you need to install the python3-venv\n'
      + 'package using the following command.\n\n    apt install python3.12-venv\n\n'
      + 'Failing command: /data/pyrekordbox/bin/python3';
    expect(reasonFrom(venv)).toBe('The virtual environment was not created successfully because ensurepip is not available.');
    expect(reasonFrom('noise\n\nerror: externally-managed-environment\n\n× more')).toBe('error: externally-managed-environment');
    expect(reasonFrom('only line')).toBe('only line');
  });
});

describe('the one-liner', () => {
  it('is the command the load screen shows', () => {
    // Two copies — the main process runs it, the renderer displays it — must not drift.
    expect(keyCommandFor('windows').command).toContain(PYREKORDBOX_KEY_ONE_LINER);
    expect(keyCommandFor('linux').command).toContain(PYREKORDBOX_KEY_ONE_LINER);
  });

  it('finds the interpreter inside the environment on each platform', () => {
    expect(venvPython('C:\\Users\\dj\\AppData\\Roaming\\app\\pyrekordbox', 'win32'))
      .toBe('C:\\Users\\dj\\AppData\\Roaming\\app\\pyrekordbox\\Scripts\\python.exe');
    expect(venvPython('/home/dj/.config/app/pyrekordbox', 'linux')).toBe('/home/dj/.config/app/pyrekordbox/bin/python');
  });

  it('tries the py launcher first on Windows', () => {
    expect(pythonCandidates('win32')[0]).toBe('py');
    expect(pythonCandidates('darwin')[0]).toBe('python3');
  });
});
