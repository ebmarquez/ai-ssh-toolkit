/**
 * ssh_session_execute tool handler — executes a command inside an open session.
 *
 * Writes the command to the PTY, waits for the shell prompt to return,
 * then returns the scrubbed output.
 */

import type { SessionStore, ManagedSession } from '../ssh/session-store.js';
import type { CredentialRegistry } from '../credentials/registry.js';
import type { IDisposable } from 'node-pty';
import { detectPrompt } from '../ssh/prompt-detector.js';
import { scrubOutput } from '../ssh/output-scrubber.js';
import { applyOutputLimit } from '../utils/output-limiter.js';
import type { StreamStore } from '../ssh/stream-store.js';
import {
  type EscalationCredentialRef,
  fetchEscalationCredential,
  buildSudoCommand,
  detectSudoPrompt,
  detectEnablePrompt,
  isSudoPasswordRequired,
  validateEscalationInputs,
} from '../ssh/privilege-escalation.js';

export interface SshSessionExecuteInput {
  session_id: string;
  command: string;
  timeout_ms?: number; // default 30000
  /** Maximum output bytes before truncation (default: 65 536 = 64 KB). */
  max_output_bytes?: number;
  /** If provided, always write full output to this file path. */
  output_to_file?: string;
  /** When true, run asynchronously and return a stream_id for polling. */
  stream?: boolean;
  /** When true, run the command under sudo. */
  sudo?: boolean;
  /** Credential ref for the sudo password. */
  sudo_password_ref?: EscalationCredentialRef;
  /** Credential ref for Cisco IOS enable mode password. */
  enable_password_ref?: EscalationCredentialRef;
}

export interface SshSessionExecuteResult {
  output: string;
  exit_code: number | null; // null for interactive sessions
  session_id: string;
  truncated?: boolean;
  total_bytes?: number;
  head?: string;
  tail?: string;
  saved_path?: string;
}

export interface SshSessionExecuteStreamResult {
  stream_id: string;
  session_id: string;
  status: 'running';
}

export async function sshSessionExecute(
  sessionStore: SessionStore,
  input: SshSessionExecuteInput,
  streamStore?: StreamStore,
  registry?: CredentialRegistry,
): Promise<SshSessionExecuteResult | SshSessionExecuteStreamResult> {
  const { session_id, command, timeout_ms = 30_000, stream = false } = input;

  // Validate escalation input combinations
  validateEscalationInputs(input);

  if (!session_id?.trim()) {
    throw new Error('session_id is required and cannot be empty');
  }
  if (!command?.trim()) {
    throw new Error('command is required and cannot be empty');
  }

  const sessionOrUndef = sessionStore.get(session_id);
  if (!sessionOrUndef) {
    throw new Error('Session not found or expired');
  }
  const session: ManagedSession = sessionOrUndef;

  if (session.inFlight) {
    throw new Error('A command is already running on this session. Wait for it to complete.');
  }

  // ── Privilege escalation setup ─────────────────────────────────────────
  let sudoPasswordBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let enablePasswordBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let finalCommand = command;

  if (input.sudo) {
    if (input.sudo_password_ref) {
      if (!registry) {
        throw new Error('CredentialRegistry is required for sudo_password_ref');
      }
      sudoPasswordBuffer = await fetchEscalationCredential(registry, input.sudo_password_ref);
      finalCommand = buildSudoCommand(command, true);
    } else {
      finalCommand = buildSudoCommand(command, false);
    }
  }

  if (input.enable_password_ref) {
    if (!registry) {
      throw new Error('CredentialRegistry is required for enable_password_ref');
    }
    enablePasswordBuffer = await fetchEscalationCredential(registry, input.enable_password_ref);
  }

  // Update activity timestamp
  session.lastActivity = Date.now();
  session.outputBuffer = ''; // reset capture buffer for this command
  session.inFlight = true;

  const sess = session; // capture for closure — TypeScript narrowing guard
  const hasEnable = enablePasswordBuffer.length > 0;

  // Streaming path: return immediately, feed chunks to StreamStore
  if (stream && streamStore) {
    const streamId = crypto.randomUUID();
    // For session streaming, cancel sends Ctrl-C then fails the stream
    streamStore.create(streamId, sess.host, command, () => {
      try { sess.ptyProcess.write('\x03'); } catch { /* ignore */ }
    });

    const effectiveTimeout = input.timeout_ms ?? 300_000;

    const promise = new Promise<SshSessionExecuteResult>((resolve, reject) => {
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
        fail(new Error(`ssh_session_execute timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);

      dataDisposable = sess.ptyProcess.onData((data: string) => {
        if (settled) return;
        captureBuffer += data;
        sess.outputBuffer += data;
        sess.lastActivity = Date.now();
        try { streamStore.appendChunk(streamId, data, 'stdout'); } catch { /* ignore */ }
        if (detectPrompt(captureBuffer, sess.platform)) {
          finish(captureBuffer);
        }
      });
      sess.disposables.push(dataDisposable);

      exitDisposable = sess.ptyProcess.onExit(({ exitCode }) => {
        sessionStore.delete(sess.id);
        fail(new Error(`SSH PTY exited unexpectedly with code ${exitCode} during command execution`));
      });
      sess.disposables.push(exitDisposable);

      try {
        sess.ptyProcess.write(command + '\r');
      } catch (err) {
        sessionStore.delete(sess.id);
        fail(new Error(`Failed to write to PTY: ${String(err)}`));
      }
    });

    // Handle completion/failure in the background
    promise
      .then(() => streamStore.complete(streamId, null))
      .catch((err) => streamStore.fail(streamId, err instanceof Error ? err.message : String(err)));

    return { stream_id: streamId, session_id, status: 'running' as const };
  }

  // Non-streaming path
  const base = await new Promise<SshSessionExecuteResult>((resolve, reject) => {
    let captureBuffer = '';
    let settled = false;
    let dataDisposable: IDisposable | undefined;
    let sudoPasswordSent = false;
    let enablePasswordSent = false;
    let enableCommandSent = !hasEnable; // skip enable phase if not needed

    let exitDisposable: IDisposable | undefined;

    function cleanup() {
      // Zero escalation buffers
      sudoPasswordBuffer.fill(0);
      enablePasswordBuffer.fill(0);
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

      // ── Enable mode: wait for password prompt after sending 'enable' ──
      if (hasEnable && !enablePasswordSent && detectEnablePrompt(captureBuffer)) {
        enablePasswordSent = true;
        try {
          sess.ptyProcess.write(enablePasswordBuffer.toString('utf-8') + '\r');
        } catch (err) {
          sessionStore.delete(sess.id);
          fail(new Error(`Failed to write enable password to PTY: ${String(err)}`));
        }
        // Reset capture to collect output after enable auth
        captureBuffer = '';
        return;
      }

      // ── Enable mode: after password sent, wait for prompt then send command ──
      if (hasEnable && enablePasswordSent && !enableCommandSent && detectPrompt(captureBuffer, sess.platform)) {
        enableCommandSent = true;
        captureBuffer = ''; // reset to capture only command output
        try {
          sess.ptyProcess.write(finalCommand + '\r');
        } catch (err) {
          sessionStore.delete(sess.id);
          fail(new Error(`Failed to write command to PTY: ${String(err)}`));
        }
        return;
      }

      // ── Sudo password prompt ──────────────────────────────────────────
      if (input.sudo && !sudoPasswordSent && detectSudoPrompt(captureBuffer)) {
        sudoPasswordSent = true;
        if (sudoPasswordBuffer.length === 0) {
          fail(new Error('Sudo password prompt received but no sudo_password_ref was provided.'));
          return;
        }
        try {
          sess.ptyProcess.write(sudoPasswordBuffer.toString('utf-8') + '\r');
        } catch (err) {
          sessionStore.delete(sess.id);
          fail(new Error(`Failed to write sudo password to PTY: ${String(err)}`));
        }
        return;
      }

      // ── Detect sudo -n failure ────────────────────────────────────────
      if (input.sudo && !sudoPasswordSent && isSudoPasswordRequired(captureBuffer)) {
        fail(new Error(
          'Passwordless sudo (sudo -n) failed: a password is required. ' +
          'Provide sudo_password_ref with a credential backend and reference to supply the sudo password.',
        ));
        return;
      }

      // ── Normal prompt detection (command finished) ────────────────────
      if (enableCommandSent && detectPrompt(captureBuffer, sess.platform)) {
        finish(captureBuffer);
      }
    });
    sess.disposables.push(dataDisposable);

    // Listen for PTY exit (fast-fail instead of waiting for timeout)
    // Also pushed to sess.disposables so SessionStore.delete/destroy cleans it up
    exitDisposable = sess.ptyProcess.onExit(({ exitCode }) => {
      // Remove the dead session from the store so subsequent calls get "Session not found"
      sessionStore.delete(sess.id);
      fail(new Error(`SSH PTY exited unexpectedly with code ${exitCode} during command execution`));
    });
    sess.disposables.push(exitDisposable);

    // Write the initial command to the PTY — for enable mode, send 'enable' first
    try {
      if (hasEnable) {
        sess.ptyProcess.write('enable\r');
      } else {
        sess.ptyProcess.write(finalCommand + '\r');
      }
    } catch (err) {
      // PTY is dead — remove the session from the store and fail cleanly
      sessionStore.delete(sess.id);
      fail(new Error(`Failed to write to PTY: ${String(err)}`));
    }
  });

  // Apply output limiting after PTY interaction completes
  const limited = await applyOutputLimit(base.output, {
    max_output_bytes: input.max_output_bytes,
    output_to_file: input.output_to_file,
  });

  return { ...base, ...limited };
}
