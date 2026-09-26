import { execFile } from 'child_process';

/**
 * Get the rekordbox database key from pyrekordbox, the way the load screen
 * tells people to — but run by the app instead of copied into a terminal and
 * pasted back.
 *
 * The app still ships no key. It runs the open-source package on this machine
 * and reads what it prints: install pyrekordbox for the user if it is not
 * there, then ask it. Every command is fixed; nothing from the renderer is
 * passed to a shell.
 */

/** Must match the command shown in src/renderer/utils/keyExtractionCommand.ts. */
export const PYREKORDBOX_KEY_ONE_LINER =
  'from pyrekordbox.utils import deobfuscate; '
  + 'from pyrekordbox.db6.database import BLOB; '
  + 'print(deobfuscate(BLOB))';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (command: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export type KeyRecovery =
  | { ok: true; key: string; python: string; installed: boolean }
  | { ok: false; reason: 'no-python' | 'install-failed' | 'no-key'; detail: string };

/**
 * The Pythons to try, in order. On Windows the `py` launcher comes first:
 * a bare `python` there is often the Microsoft Store alias, which opens the
 * Store instead of running anything.
 */
export function pythonCandidates(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['py', 'python'] : ['python3', 'python'];
}

const lastLine = (text: string) => text.trim().split(/\r?\n/).pop() ?? '';

export async function recoverDbKey(platform: NodeJS.Platform, run: Runner = runFile): Promise<KeyRecovery> {
  let python: string | null = null;
  for (const candidate of pythonCandidates(platform)) {
    const probe = await run(candidate, ['--version'], 15_000);
    if (probe.code === 0 && /python 3/i.test(probe.stdout + probe.stderr)) { python = candidate; break; }
  }
  if (!python) {
    return {
      ok: false, reason: 'no-python',
      detail: 'Python 3 was not found. Install it from python.org, then try again — or paste the key by hand.',
    };
  }

  let installed = false;
  const present = await run(python, ['-c', 'import pyrekordbox'], 30_000);
  if (present.code !== 0) {
    const install = await run(python, ['-m', 'pip', 'install', '--quiet', '--user', 'pyrekordbox'], 300_000);
    if (install.code !== 0) {
      return {
        ok: false, reason: 'install-failed',
        detail: `pyrekordbox could not be installed: ${lastLine(install.stderr || install.stdout) || `pip exited with ${install.code}`}`,
      };
    }
    installed = true;
  }

  const printed = await run(python, ['-c', PYREKORDBOX_KEY_ONE_LINER], 60_000);
  const key = lastLine(printed.stdout);
  if (printed.code !== 0 || !/^[0-9a-f]{64}$/i.test(key)) {
    return {
      ok: false, reason: 'no-key',
      detail: `pyrekordbox did not print a key: ${lastLine(printed.stderr) || key || `exit ${printed.code}`}`,
    };
  }
  return { ok: true, key: key.toLowerCase(), python, installed };
}

function runFile(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (error?.message ?? '') });
      }
    );
  });
}
