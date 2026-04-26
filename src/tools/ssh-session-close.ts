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

  if (!session_id?.trim()) {
    throw new Error('session_id is required and cannot be empty');
  }

  const session = sessionStore.get(session_id);
  if (!session) {
    throw new Error('Session not found or expired');
  }

  if (session.inFlight) {
    throw new Error('Cannot close session while a command is executing. Wait for the command to complete or time out.');
  }

  // Gracefully send exit, then let SessionStore.delete() own the kill + dispose
  try {
    session.ptyProcess.write('exit\r');
  } catch {
    // PTY may already be dead — continue
  }

  sessionStore.delete(session_id);

  return { message: 'Session closed' };
}
