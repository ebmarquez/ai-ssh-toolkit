/**
 * ssh_session_execute tool handler — executes a command inside an open session.
 *
 * Writes the command to the PTY, waits for the shell prompt to return,
 * then returns the scrubbed output.
 */

import type { SessionStore, ManagedSession } from '../ssh/session-store.js';
import type { IDisposable } from 'node-pty';
import { detectPrompt } from '../ssh/prompt-detector.js';
import { scrubOutput } from '../ssh/output-scrubber.js';

export interface SshSessionExecuteInput {
  session_id: string;
  command: string;
  timeout_ms?: number; // default 30000
}

export interface SshSessionExecuteResult {
  output: string;
  exit_code: number | null; // null for interactive sessions
  session_id: string;
}

export async function sshSessionExecute(
  sessionStore: SessionStore,
  input: SshSessionExecuteInput,
): Promise<SshSessionExecuteResult> {
  const { session_id, command, timeout_ms = 30_000 } = input;

  const sessionOrUndef = sessionStore.get(session_id);
  if (!sessionOrUndef) {
    throw new Error('Session not found or expired');
  }
  const session: ManagedSession = sessionOrUndef;

  if (session.inFlight) {
    throw new Error('A command is already running on this session. Wait for it to complete.');
  }

  // Update activity timestamp
  session.lastActivity = Date.now();
  session.outputBuffer = ''; // reset capture buffer for this command
  session.inFlight = true;

  const sess = session; // capture for closure — TypeScript narrowing guard

  return new Promise<SshSessionExecuteResult>((resolve, reject) => {
    let captureBuffer = '';
    let settled = false;
    let dataDisposable: IDisposable | undefined;

    let exitDisposable: IDisposable | undefined;

    function cleanup() {
      if (dataDisposable) {
        try { dataDisposable.dispose(); } catch { /* ignore */ }
        const idx = sess.disposables.indexOf(dataDisposable);
        if (idx !== -1) sess.disposables.splice(idx, 1);
        dataDisposable = undefined;
      }
      if (exitDisposable) {
        try { exitDisposable.dispose(); } catch { /* ignore */ }
        const eidx = sess.disposables.indexOf(exitDisposable);
        if (eidx !== -1) sess.disposables.splice(eidx, 1);
        exitDisposable = undefined;
      }
      sess.inFlight = false;
    }

    function finish(output: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      const cleaned = scrubOutput(output);
      resolve({ output: cleaned, exit_code: null, session_id });
    }

    function fail(err: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    }

    const timer = setTimeout(() => {
      fail(new Error(`ssh_session_execute timed out after ${timeout_ms}ms`));
    }, timeout_ms);

    // Listen for PTY output
    dataDisposable = sess.ptyProcess.onData((data: string) => {
      if (settled) return;
      captureBuffer += data;
      sess.outputBuffer += data;
      sess.lastActivity = Date.now();

      if (detectPrompt(captureBuffer, sess.platform)) {
        finish(captureBuffer);
      }
    });
    sess.disposables.push(dataDisposable);

    // Listen for PTY exit (fast-fail instead of waiting for timeout)
    // Also pushed to sess.disposables so SessionStore.delete/destroy cleans it up
    exitDisposable = sess.ptyProcess.onExit(({ exitCode }) => {
      fail(new Error(`SSH PTY exited unexpectedly with code ${exitCode} during command execution`));
    });
    sess.disposables.push(exitDisposable);

    // Write the command to the PTY — wrap in try/catch so a dead PTY
    // doesn't leave inFlight=true and listeners dangling
    try {
      sess.ptyProcess.write(command + '\r');
    } catch (err) {
      fail(new Error(`Failed to write to PTY: ${String(err)}`));
    }
  });
}
