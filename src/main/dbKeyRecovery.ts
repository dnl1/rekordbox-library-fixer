import { execFile } from 'child_process';
import * as path from 'path';

/**
 * Get the rekordbox database key from pyrekordbox, the way the load screen
 * tells people to — but run by the app instead of copied into a terminal and
 * pasted back.
 *
 * The app still ships no key. It runs the open-source package on this machine
 * and reads what it prints. Every command is fixed; nothing from the renderer
 * is passed to a shell.
 *
 * Where pyrekordbox comes from, in order: the Python already on the machine if
 * it has it; else a virtual environment of the app's own, in its data folder;
 * else `pip install --user`. The private environment comes before `--user`
 * because Homebrew's Python and recent Debian and Ubuntu refuse `--user`
 * installs outright ("externally-managed-environment") and it leaves the
 * user's own packages alone. `--user` stays for a Python without `venv`.
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

/**
 * The line of a failure that says why. pip and venv end on a line that only
 * names the command that failed; the cause — "ensurepip is not available",
 * "externally-managed-environment" — is further up.
 */
export function reasonFrom(text: string): string {
  // Tools wrap their messages, so a sentence is read across its lines: split
  // into paragraphs at blank lines, rejoin each, and take the first sentence
  // of the one that explains.
  const paragraphs = text.trim().split(/\r?\n\s*\r?\n/)
    .map((p) => p.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' '))
    .filter(Boolean);
  const explains = /error|ensurepip|not available|externally-managed|no module named|permission denied/i;
  const telling = paragraphs.find((p) => explains.test(p));
  if (!telling) { return lastLine(text); }
  return telling.match(/^.*?[.!](?=\s|$)/)?.[0] ?? telling;
}

/** The interpreter inside a virtual environment created at `dir`. */
export function venvPython(dir: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? path.win32.join(dir, 'Scripts', 'python.exe')
    : path.posix.join(dir, 'bin', 'python');
}

export async function recoverDbKey(
  platform: NodeJS.Platform,
  run: Runner = runFile,
  venvDir?: string
): Promise<KeyRecovery> {
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
  let interpreter = python;
  const has = async (py: string) => (await run(py, ['-c', 'import pyrekordbox'], 30_000)).code === 0;

  if (!(await has(python))) {
    const failures: string[] = [];
    let ready = false;

    if (venvDir) {
      const inVenv = venvPython(venvDir, platform);
      if (await has(inVenv)) {
        interpreter = inVenv;
        ready = true;
      } else {
        const created = await run(python, ['-m', 'venv', venvDir], 120_000);
        const install = created.code === 0
          ? await run(inVenv, ['-m', 'pip', 'install', '--quiet', 'pyrekordbox'], 300_000)
          : created;
        if (install.code === 0) {
          interpreter = inVenv;
          ready = installed = true;
        } else {
          failures.push(`a private environment: ${reasonFrom(`${install.stderr}\n${install.stdout}`) || `exit ${install.code}`}`);
        }
      }
    }

    if (!ready) {
      const install = await run(python, ['-m', 'pip', 'install', '--quiet', '--user', 'pyrekordbox'], 300_000);
      if (install.code === 0) {
        ready = installed = true;
      } else {
        failures.push(`pip --user: ${reasonFrom(`${install.stderr}\n${install.stdout}`) || `exit ${install.code}`}`);
      }
    }

    if (!ready) {
      return { ok: false, reason: 'install-failed', detail: `pyrekordbox could not be installed — ${failures.join('; ')}` };
    }
  }

  const printed = await run(interpreter, ['-c', PYREKORDBOX_KEY_ONE_LINER], 60_000);
  const key = lastLine(printed.stdout);
  if (printed.code !== 0 || !/^[0-9a-f]{64}$/i.test(key)) {
    return {
      ok: false, reason: 'no-key',
      detail: `pyrekordbox did not print a key: ${lastLine(printed.stderr) || key || `exit ${printed.code}`}`,
    };
  }
  return { ok: true, key: key.toLowerCase(), python: interpreter, installed };
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
        // Python's venv explains a failure on stdout, so the process's own output
        // comes before the generic "Command failed" of the error.
        const out = String(stdout ?? '');
        const err = String(stderr ?? '');
        resolve({ code, stdout: out, stderr: err || (out.trim() ? '' : (error?.message ?? '')) });
      }
    );
  });
}
