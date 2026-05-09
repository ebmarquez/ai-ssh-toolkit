/**
 * ssh_execute tool handler — runs a command over an interactive SSH PTY session.
 */

import type { PlatformHint } from '../ssh/prompt-detector.js';
import type { CredentialRegistry } from '../credentials/registry.js';
import { runSshSession } from '../ssh/pty-manager.js';
import { resolveSshConfig } from '../ssh/ssh-config-reader.js';
import type { CredentialMap } from '../credentials/credential-map.js';
import { applyOutputLimit } from '../utils/output-limiter.js';

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
  /**
   * When true, resolve host/credentials/args but do NOT actually connect.
   * Returns a structured preview of what would be executed.
   */
  dry_run?: boolean;
  /** Maximum output bytes before truncation (default: 65 536 = 64 KB). */
  max_output_bytes?: number;
  /** If provided, always write full output to this file path. */
  output_to_file?: string;
}

export interface SshExecuteResult {
  output: string;
  exit_code: number | null;
  truncated?: boolean;
  total_bytes?: number;
  head?: string;
  tail?: string;
  saved_path?: string;
}

export interface SshExecuteDryRunResult {
  dry_run: true;
  resolved_host: string;
  resolved_user: string;
  resolved_port: number;
  credential_backend: string | null;
  credential_ref: string | null;
  ssh_command_preview: string[];
  jump_hosts_resolved: string | null;
}

export async function sshExecute(
  registry: CredentialRegistry,
  input: SshExecuteInput,
  credentialMap: CredentialMap,
): Promise<SshExecuteResult | SshExecuteDryRunResult> {
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
    dry_run = false,
  } = input;

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

  if (dry_run) {
    // Verify backend availability without fetching actual credentials
    if (credential_ref !== undefined) {
      if (!credential_ref.trim()) {
        throw new Error('credential_ref cannot be empty');
      }
      const backendName = credential_backend ?? 'google-secret-manager';
      const backend = registry.getBackend(backendName);
      const available = await backend.isAvailable();
      if (!available) {
        process.stderr.write(`Credential backend "${backendName}" unavailable in ssh_execute\n`);
        throw new Error(`Credential backend "${backendName}" failed. Check server logs for details.`);
      }
    }

    // Resolve SSH config
    const useSshConfig = input.use_ssh_config ?? true;
    let resolvedHost = host;
    let resolvedPort = 22;
    let jumpHostsResolved: string | null = null;

    if (useSshConfig) {
      const cfg = await resolveSshConfig(host);
      if (cfg) {
        resolvedHost = cfg.hostname;
        if (!resolvedUsername) resolvedUsername = cfg.user ?? '';
        if (cfg.port !== 22) resolvedPort = cfg.port;
        jumpHostsResolved = cfg.proxyJump ?? null;
      }
    }

    // Build ssh args preview (mirrors pty-manager.ts)
    const sshArgs: string[] = [
      'ssh',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'NumberOfPasswordPrompts=1',
      '-o', 'ConnectTimeout=10',
    ];
    if (resolvedPort !== 22) {
      sshArgs.push('-p', String(resolvedPort));
    }
    sshArgs.push('--', `${resolvedUsername || '<unresolved>'}@${host}`, command);

    return {
      dry_run: true,
      resolved_host: resolvedHost,
      resolved_user: resolvedUsername || '<unresolved>',
      resolved_port: resolvedPort,
      credential_backend: credential_backend ?? null,
      credential_ref: credential_ref ?? null,
      ssh_command_preview: sshArgs,
      jump_hosts_resolved: jumpHostsResolved,
    };
  }

  // ── Normal (non-dry-run) execution path ──────────────────────────────────
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
        const health = await backend.checkHealth();
        const diagnostic = health.reason ?? 'unknown reason';
        throw new Error(`Credential backend "${backendName}" is not available: ${diagnostic}`);
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

  // Run the PTY session
  try {
    const result = await runSshSession({
      host,
      username: resolvedUsername || undefined,
      password: passwordBuffer,
      command,
      platform,
      timeout_ms,
      use_ssh_config: input.use_ssh_config ?? true,
    });

    // Apply output limiting
    const limited = await applyOutputLimit(result.output, {
      max_output_bytes: input.max_output_bytes,
      output_to_file: input.output_to_file,
    });

    return { ...result, ...limited };
  } finally {
    // Zero-fill password buffer after PTY session completes (success or failure)
    passwordBuffer.fill(0);
  }
}
