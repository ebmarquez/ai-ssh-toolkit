/**
 * ssh_execute tool handler — runs a command over an interactive SSH PTY session.
 */

import type { PlatformHint } from '../ssh/prompt-detector.js';
import type { CredentialRegistry } from '../credentials/registry.js';
import { runSshSession } from '../ssh/pty-manager.js';
import type { CredentialMap } from '../credentials/credential-map.js';
import {
  type EscalationCredentialRef,
  fetchEscalationCredential,
  buildSudoCommand,
  validateEscalationInputs,
} from '../ssh/privilege-escalation.js';

export interface SshExecuteInput {
  host: string;
  command: string;
  username?: string;
  credential_ref?: string;
  credential_backend?: string;
  platform?: PlatformHint;
  timeout_ms?: number;
  /**
   * When true (default), resolve ~/.ssh/config for the given host alias so that
   * ssh_config(5) directives (HostName, User, Port, IdentityFile, ProxyJump, etc.)
   * are applied. Tool arguments always take precedence over config values.
   * Set to false to bypass ssh config lookup entirely.
   */
  use_ssh_config?: boolean;
  /** When true, run the command under sudo. Uses sudo -n (non-interactive)
   *  if no sudo_password_ref is provided. */
  sudo?: boolean;
  /** Credential ref for the sudo password (separate from login credential). */
  sudo_password_ref?: EscalationCredentialRef;
}

export interface SshExecuteResult {
  output: string;
  exit_code: number | null;
}

export async function sshExecute(
  registry: CredentialRegistry,
  input: SshExecuteInput,
  credentialMap: CredentialMap,
): Promise<SshExecuteResult> {
  let {
    credential_ref,
    credential_backend,
  } = input;
  const {
    host,
    command,
    username,
    platform = 'auto',
    timeout_ms = 30000,
  } = input;

  // Validate escalation input combinations
  validateEscalationInputs(input);

  // Validate required inputs before any lookups
  if (!host) throw new Error('host is required');
  if (!command) throw new Error('command is required');

  // Credential map fallback: if no explicit backend/ref, consult the map
  let mappedUsername: string | undefined;
  if (credential_backend === undefined && credential_ref === undefined) {
    const mapped = credentialMap.resolve(host);
    if (mapped) {
      credential_backend = mapped.backend;
      credential_ref = mapped.ref;
      mappedUsername = mapped.username;
    }
  }

  // Resolve credentials
  let resolvedUsername = username ?? mappedUsername ?? '';
  // node Buffer — use ArrayBufferLike to satisfy TS6 strict generic check
  let passwordBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  if (credential_ref !== undefined) {
    if (!credential_ref.trim()) {
      throw new Error('credential_ref cannot be empty');
    }
    const backendName = credential_backend ?? 'google-secret-manager';
    const backend = registry.getBackend(backendName);
    try {
      const available = await backend.isAvailable();
      if (!available) {
        process.stderr.write(`Credential backend "${backendName}" unavailable in ssh_execute\n`);
        throw new Error(`Credential backend "${backendName}" failed. Check server logs for details.`);
      }
      const cred = await backend.getCredential(credential_ref);
      resolvedUsername = cred.username || resolvedUsername;
      // Copy into our own buffer so backend.cleanup() zeroing stagedBuffers
      // doesn't wipe our copy before we send it to the PTY session.
      passwordBuffer = Buffer.from(cred.password) as Buffer<ArrayBufferLike>;
      // Zero the original credential buffer immediately after copying — don't
      // rely on backend.cleanup() which may be a no-op (e.g. GoogleSecretManager).
      cred.password.fill(0);
    } finally {
      // cleanup() zeros the backend's staged copy (not our local copy above)
      await backend.cleanup();
    }
  }

  // Don't throw here when resolvedUsername is empty — pty-manager will attempt
  // ssh config resolution first (if use_ssh_config is enabled) and throw with
  // a better error message if username resolution still fails.

  // ── Privilege escalation ─────────────────────────────────────────────────
  let sudoPasswordBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let finalCommand = command;

  if (input.sudo) {
    if (input.sudo_password_ref) {
      sudoPasswordBuffer = await fetchEscalationCredential(registry, input.sudo_password_ref);
      finalCommand = buildSudoCommand(command, true);
    } else {
      finalCommand = buildSudoCommand(command, false);
    }
  }

  // Run the PTY session
  try {
    const result = await runSshSession({
      host,
      username: resolvedUsername || undefined,
      password: passwordBuffer,
      command: finalCommand,
      platform,
      timeout_ms,
      use_ssh_config: input.use_ssh_config ?? true,
      sudo_password: sudoPasswordBuffer.length > 0 ? sudoPasswordBuffer : undefined,
    });
    return result;
  } finally {
    // Zero-fill password buffers after PTY session completes (success or failure)
    passwordBuffer.fill(0);
    sudoPasswordBuffer.fill(0);
  }
}
