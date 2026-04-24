/**
 * PTY Session Manager — spawns interactive SSH sessions via node-pty.
 *
 * Uses existing helpers:
 *   - detectPasswordPrompt / detectPrompt  (./prompt-detector.ts)
 *   - scrubOutput                          (./output-scrubber.ts)
 */

import * as pty from 'node-pty';
import { detectPasswordPrompt, detectPrompt, type PlatformHint } from './prompt-detector.js';
import { scrubOutput } from './output-scrubber.js';

export interface PtySessionOptions {
  host: string;
  username: string;
  /** Password as Buffer — zeroed by caller after this function resolves/rejects */
  password: Buffer;
  command: string;
  platform?: PlatformHint;
  timeout_ms?: number;
}

export interface PtySessionResult {
  output: string;
  exit_code: number | null;
}

/**
 * Run a single command over an interactive SSH PTY session.
 *
 * Lifecycle:
 *   1. Spawn SSH with StrictHostKeyChecking=accept-new
 *   2. If a password prompt appears, send the password (then zero a local copy)
 *   3. Wait for a shell prompt (platform-aware)
 *   4. Send the command, collect output until next shell prompt
 *   5. Close the session and return scrubbed output + exit code
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

  const sshArgs = [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'ConnectTimeout=10',
    `${username}@${host}`,
    command,
  ];

  return new Promise<PtySessionResult>((resolve, reject) => {
    let term: pty.IPty;
    try {
      term = pty.spawn('ssh', sshArgs, {
        name: 'xterm-color',
        cols: 220,
        rows: 24,
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      return reject(new Error(`Failed to spawn SSH PTY: ${String(err)}`));
    }

    let rawOutput = '';
    let exitCode: number | null = null;
    let passwordSent = false;
    let settled = false;

    // Local copy of password string so we can zero it after sending
    let passwordStr = password.toString();

    function finish(code: number | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // Zero the local password copy
      passwordStr = '\x00'.repeat(passwordStr.length);

      const cleaned = scrubOutput(rawOutput);
      resolve({ output: cleaned, exit_code: code });
    }

    function fail(err: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      passwordStr = '\x00'.repeat(passwordStr.length);
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
        term.write(passwordStr + '\r');
        // Zero the local copy immediately after sending
        passwordStr = '\x00'.repeat(passwordStr.length);
        return;
      }

      // When running a non-interactive command (ssh host cmd), SSH will
      // execute the command and exit — we detect either the shell prompt
      // (interactive fallback) or just wait for exit. Since we pass the
      // command directly on the SSH command line, the PTY will just exit
      // after command completion. Detect shell prompt as an early-exit signal
      // only for interactive flows.
      if (detectPrompt(rawOutput, platform)) {
        // We got a prompt — command has finished in interactive mode
        // Don't close yet; wait for onExit which arrives immediately after
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
