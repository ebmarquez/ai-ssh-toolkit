/**
 * ssh_session_execute tool handler — executes a command inside an open session.
 *
 * Writes the command to the PTY, waits for the shell prompt to return,
 * then returns the scrubbed output.
 */

import type { SessionStore } from '../ssh/session-store.js';
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

  const session = sessionStore.get(session_id);
  if (!session) {
    throw new Error('Session not found or expired');
  }

  // Update activity timestamp
  session.lastActivity = Date.now();
  session.outputBuffer = ''; // reset capture buffer for this command

  return new Promise<SshSessionExecuteResult>((resolve, reject) => {
    let captureBuffer = '';
    let settled = false;

    function finish(output: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Remove data listener by resetting onData to a no-op — we can't
      // unsubscribe in node-pty, so we gate on the `settled` flag instead.
      const cleaned = scrubOutput(output);
      resolve({ output: cleaned, exit_code: null, session_id });
    }

    function fail(err: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    }

    const timer = setTimeout(() => {
      fail(new Error(`ssh_session_execute timed out after ${timeout_ms}ms`));
    }, timeout_ms);

    // Listen for PTY output
    session.ptyProcess.onData((data: string) => {
      if (settled) return;
      captureBuffer += data;
      session.outputBuffer += data;
      session.lastActivity = Date.now();

      if (detectPrompt(captureBuffer, session.platform)) {
        finish(captureBuffer);
      }
    });

    // Write the command to the PTY
    session.ptyProcess.write(command + '\n');
  });
}
