/**
 * ssh_session_open tool handler — opens a persistent interactive SSH shell session.
 *
 * Returns a session_id that callers can use with ssh_session_execute and
 * ssh_session_close. The session remains open until explicitly closed or
 * until it is evicted by the SessionStore idle-timeout.
 */

import type { PlatformHint } from '../ssh/prompt-detector.js';
import type { CredentialRegistry } from '../credentials/registry.js';
import type { SessionStore } from '../ssh/session-store.js';
import { detectPasswordPrompt, detectPrompt } from '../ssh/prompt-detector.js';

export interface SshSessionOpenInput {
  host: string;
  username?: string;
  credential_ref?: string;
  credential_backend?: string;
  platform?: PlatformHint;
  timeout_ms?: number;      // connect + initial prompt timeout (default: 30000)
  idle_timeout_ms?: number; // inactivity auto-close passed to SessionStore (default: 300000)
}

export interface SshSessionOpenResult {
  session_id: string;
  host: string;
  username: string;
  message: string;
}

export async function sshSessionOpen(
  registry: CredentialRegistry,
  sessionStore: SessionStore,
  input: SshSessionOpenInput,
): Promise<SshSessionOpenResult> {
  const {
    host,
    username,
    credential_ref,
    credential_backend,
    platform = 'auto',
    timeout_ms = 30_000,
    idle_timeout_ms,
  } = input;

  if (!host) throw new Error('host is required');

  // ── Resolve credentials ──────────────────────────────────────────────────
  let resolvedUsername = username ?? '';
  let passwordBuffer: Buffer = Buffer.alloc(0);

  if (credential_ref !== undefined) {
    if (!credential_ref.trim()) throw new Error('credential_ref cannot be empty');

    const backendName = credential_backend ?? 'google-secret-manager';
    const backend = registry.getBackend(backendName);
    try {
      const available = await backend.isAvailable();
      if (!available) {
        process.stderr.write(`Credential backend "${backendName}" unavailable in ssh_session_open\n`);
        throw new Error(`Credential backend "${backendName}" failed. Check server logs for details.`);
      }
      const cred = await backend.getCredential(credential_ref);
      resolvedUsername = cred.username || resolvedUsername;
      passwordBuffer = Buffer.from(cred.password);
      cred.password.fill(0);
    } finally {
      await backend.cleanup();
    }
  }

  if (!resolvedUsername) {
    throw new Error(
      'username is required (provide username or a credential_ref with a username)',
    );
  }

  // ── Dynamic import (allows mocking in tests) ─────────────────────────────
  const { default: pty } = await import('node-pty');

  // ── Env allowlist (same pattern as pty-manager.ts) ───────────────────────
  const childEnv: Record<string, string> = {};
  const allowlist = [
    'HOME', 'PATH', 'TERM', 'LANG', 'LC_ALL',
    'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP',
  ];
  for (const key of allowlist) {
    const value = process.env[key];
    if (value) childEnv[key] = value;
  }
  childEnv.TERM ??= 'xterm-color';

  // ── Spawn interactive shell (no command in argv → opens a shell) ──────────
  const sshArgs = [
    '-tt',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'ConnectTimeout=10',
    `${resolvedUsername}@${host}`,
    // Intentionally no command — we want an interactive shell
  ];

  return new Promise<SshSessionOpenResult>((resolve, reject) => {
    let term: import('node-pty').IPty;
    try {
      term = pty.spawn('ssh', sshArgs, {
        name: 'xterm-color',
        cols: 220,
        rows: 24,
        env: childEnv,
      });
    } catch (err) {
      passwordBuffer.fill(0);
      return reject(new Error(`Failed to spawn SSH PTY: ${String(err)}`));
    }

    let outputBuffer = '';
    let passwordSent = false;
    let settled = false;

    function succeed() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      passwordBuffer.fill(0);

      const sessionId = crypto.randomUUID();
      sessionStore.add({
        id: sessionId,
        ptyProcess: term,
        lastActivity: Date.now(),
        host,
        username: resolvedUsername,
        platform,
        outputBuffer: '',
        idleTimeoutMs: idle_timeout_ms,
        inFlight: false,
        disposables: [],
      });

      resolve({
        session_id: sessionId,
        host,
        username: resolvedUsername,
        message: 'Session opened successfully',
      });
    }

    function fail(err: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      passwordBuffer.fill(0);
      try { term.kill(); } catch { /* ignore */ }
      reject(err);
    }

    const timer = setTimeout(() => {
      fail(new Error(`SSH session open timed out after ${timeout_ms}ms`));
    }, timeout_ms);

    term.onData((data: string) => {
      if (settled) return;
      outputBuffer += data;

      // Handle password prompt
      if (!passwordSent && detectPasswordPrompt(outputBuffer)) {
        passwordSent = true;
        if (!passwordBuffer || passwordBuffer.length === 0) {
          fail(new Error(
            'SSH password prompt received but no credential was provided. ' +
            'Use credential_ref to supply credentials, or ensure key-based auth is configured.',
          ));
          return;
        }
        term.write(passwordBuffer.toString('utf-8') + '\r');
        passwordBuffer.fill(0);
        return;
      }

      // Wait for the initial shell prompt before declaring the session ready
      if (detectPrompt(outputBuffer, platform)) {
        succeed();
      }
    });

    term.onExit(({ exitCode }: { exitCode: number }) => {
      fail(new Error(`SSH process exited unexpectedly with code ${exitCode}`));
    });
  });
}
