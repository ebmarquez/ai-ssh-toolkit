/**
 * ssh_session_close tool handler — gracefully closes a persistent SSH session.
 */

import type { SessionStore } from '../ssh/session-store.js';

export interface SshSessionCloseInput {
  session_id: string;
}

export interface SshSessionCloseResult {
  message: string;
}

export async function sshSessionClose(
  sessionStore: SessionStore,
  input: SshSessionCloseInput,
): Promise<SshSessionCloseResult> {
  const { session_id } = input;

  const session = sessionStore.get(session_id);
  if (!session) {
    throw new Error('Session not found or expired');
  }

  // Gracefully exit the shell, then forcibly kill the PTY
  try {
    session.ptyProcess.write('exit\r');
  } catch {
    // PTY may already be dead — continue to kill
  }

  try {
    session.ptyProcess.kill();
  } catch {
    // ignore
  }

  sessionStore.delete(session_id);

  return { message: 'Session closed' };
}
