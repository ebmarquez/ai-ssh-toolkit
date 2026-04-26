/**
 * PTY Session Manager — spawns non-interactive SSH sessions via node-pty.
 *
 * Uses existing helpers:
 *   - detectPasswordPrompt / detectPrompt  (./prompt-detector.ts)
 *   - scrubOutput                          (./output-scrubber.ts)
 */

import { detectPasswordPrompt, detectPrompt, type PlatformHint } from './prompt-detector.js';
import { scrubOutput } from './output-scrubber.js';
import { SSH_PTY_OPTIONS } from './pty-options.js';

export interface PtySessionOptions {
  host: string;
  username: string;
  /** Password as Buffer — zeroed by caller after this function resolves/rejects.
   *  Optional: omit when using SSH key / agent authentication. */
  password?: Buffer;
  command: string;
  platform?: PlatformHint;
  timeout_ms?: number;
}

export interface PtySessionResult {
  output: string;
  exit_code: number | null;
}

/**
 * Run a single command over SSH using a PTY (non-interactive mode).
 *
 * Lifecycle:
 *   1. Spawn `ssh user@host <command>` — command is passed as SSH argv,
 *      so SSH executes it non-interactively and exits when it completes.
 *   2. If a password prompt appears and a password Buffer was supplied,
 *      write it to the PTY then continue waiting for process exit.
 *      If no password was supplied but a prompt is detected, the session
 *      is rejected with a clear error.
 *   3. On process exit, scrub and return the collected output + exit code.
 */
export async function runSshSession(opts: PtySessionOptions): Promise<PtySessionResult> {
  const {
    host,
    username,
    password,
    command,
    platform = 'auto',
    timeout_ms = 30000,
  } = opts;

  // Dynamic import to allow mocking in tests (matches ssh-multi-execute.ts pattern)
  const { default: pty } = await import('node-pty');

  const sshArgs = [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'ConnectTimeout=10',
    `${username}@${host}`,
    command,
  ];

  // Build a filtered environment allowlist — never expose full process.env
  // to SSH child processes.
  const childEnv: Record<string, string> = {};
  const allowlist = [
    'HOME',
    'PATH',
    'TERM',
    'LANG',
    'LC_ALL',
    // SSH config / agent vars
    'SSH_AUTH_SOCK',
    'SSH_AGENT_PID',
    // Windows/platform-critical vars
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
  ];
  for (const key of allowlist) {
    const value = process.env[key];
    if (value) childEnv[key] = value;
  }
  childEnv.TERM ??= 'xterm-color';

  return new Promise<PtySessionResult>((resolve, reject) => {
    let term: import('node-pty').IPty;
    try {
      term = pty.spawn('ssh', sshArgs, {
        ...SSH_PTY_OPTIONS,
        env: childEnv,
      });
    } catch (err) {
      return reject(new Error(`Failed to spawn SSH PTY: ${String(err)}`));
    }

    let rawOutput = '';
    let exitCode: number | null = null;
    let passwordSent = false;
    let settled = false;

    function finish(code: number | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const cleaned = scrubOutput(rawOutput);
      resolve({ output: cleaned, exit_code: code });
    }

    function fail(err: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { term.kill(); } catch { /* ignore */ }
      reject(err);
    }

    const timer = setTimeout(() => {
      fail(new Error(`SSH session timed out after ${timeout_ms}ms`));
    }, timeout_ms);

    term.onData((data: string) => {
      rawOutput += data;

      // Handle password prompt
      if (!passwordSent && detectPasswordPrompt(rawOutput)) {
        passwordSent = true;
        if (!password || password.length === 0) {
          fail(new Error(
            'SSH password prompt received but no credential was provided. ' +
            'Use credential_ref to supply credentials, or ensure key-based auth is configured.'
          ));
          return;
        }
        // Convert Buffer to string only at the moment of write — never store as a string variable.
        // Buffer.fill(0) in the caller is the only real zero-wipe.
        term.write(password.toString('utf-8') + '\r');
        return;
      }

      // When running a non-interactive command (ssh user@host <cmd>), SSH will
      // execute the command and exit — we detect either the shell prompt
      // (interactive fallback) or just wait for exit. Since we pass the
      // command directly on the SSH command line, the PTY will exit
      // after command completion.
      if (detectPrompt(rawOutput, platform)) {
        // Got a prompt — wait for onExit which arrives immediately after
      }
    });

    term.onExit(({ exitCode: code }: { exitCode: number }) => {
      exitCode = code;
      finish(exitCode);
    });
  });
}

/**
 * PtyManager class wrapper (alternative API, same underlying implementation).
 */
export class PtyManager {
  async run(opts: PtySessionOptions): Promise<PtySessionResult> {
    return runSshSession(opts);
  }
}
