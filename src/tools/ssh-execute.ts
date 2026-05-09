/**
 * ssh_execute tool handler — runs a command over an interactive SSH PTY session.
 */

import type { PlatformHint } from '../ssh/prompt-detector.js';
import type { CredentialRegistry } from '../credentials/registry.js';
import { runSshSession } from '../ssh/pty-manager.js';
import { resolveSshConfig } from '../ssh/ssh-config-reader.js';
import type { CredentialMap } from '../credentials/credential-map.js';
import { applyOutputLimit } from '../utils/output-limiter.js';
import type { HostKeyStore } from '../security/host-key-store.js';
import { verifyHostKey } from '../security/host-key-verify.js';
import type { SessionReuseManager } from '../ssh/session-reuse.js';
import type { StreamStore } from '../ssh/stream-store.js';

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
  /** ProxyJump chain — translated to `ssh -J host1,host2,...`. */
  jump_hosts?: string[];
   * When true, reuse an existing SSH ControlMaster connection if available.
   * When false, force a fresh connection. When undefined, follows the
   * AI_SSH_SESSION_REUSE_TTL_SECONDS config (enabled by default).
   */
  reuse_session?: boolean;
  /** When true, run the command asynchronously and return a stream_id for polling. */
  stream?: boolean;
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

export interface SshExecuteStreamResult {
  stream_id: string;
  status: 'running';
}

export async function sshExecute(
  registry: CredentialRegistry,
  input: SshExecuteInput,
  credentialMap: CredentialMap,
  hostKeyStore?: HostKeyStore,
): Promise<SshExecuteResult | SshExecuteDryRunResult> {
  reuseManager?: SessionReuseManager,
): Promise<SshExecuteResult> {
  streamStore?: StreamStore,
): Promise<SshExecuteResult | SshExecuteStreamResult> {
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
    stream = false,
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

  // Host key verification (TOFU)
  if (hostKeyStore) {
    await verifyHostKey(hostKeyStore, host);
  }

  // Determine whether to use session reuse (ControlMaster)
  const useReuse = input.reuse_session ?? (reuseManager?.isEnabled() ?? false);
  const extraSshArgs = (useReuse && reuseManager)
    ? reuseManager.getControlMasterArgs()
    : [];

  // Run the PTY session
  if (stream && streamStore) {
    const streamId = crypto.randomUUID();
    const abortController = new AbortController();
    streamStore.create(streamId, host, command, () => abortController.abort());

    // Use a longer default timeout for streaming (5 minutes)
    const effectiveTimeout = input.timeout_ms ?? 300_000;

    const promise = runSshSession({
      host,
      username: resolvedUsername || undefined,
      password: passwordBuffer,
      command,
      platform,
      timeout_ms: effectiveTimeout,
      use_ssh_config: input.use_ssh_config ?? true,
      onData: (data) => streamStore.appendChunk(streamId, data, 'stdout'),
      abortSignal: abortController.signal,
    });

    // Handle completion/failure in the background; clean up password
    promise
      .then((result) => streamStore.complete(streamId, result.exit_code))
      .catch((err) => streamStore.fail(streamId, err instanceof Error ? err.message : String(err)))
      .finally(() => passwordBuffer.fill(0));

    return { stream_id: streamId, status: 'running' as const };
  }

  // Non-streaming path (unchanged)
  try {
    const result = await runSshSession({
      host,
      username: resolvedUsername || undefined,
      password: passwordBuffer,
      command,
      platform,
      timeout_ms,
      use_ssh_config: input.use_ssh_config ?? true,
      jump_hosts: input.jump_hosts,
    });

    // Apply output limiting
    const limited = await applyOutputLimit(result.output, {
      max_output_bytes: input.max_output_bytes,
      output_to_file: input.output_to_file,
    });

    return { ...result, ...limited };
      extraSshArgs,
    });

    // Record successful connection for future reuse
    if (useReuse && reuseManager && resolvedUsername) {
      reuseManager.recordActivity(host, resolvedUsername);
    }

    return result;
  } finally {
    // Zero-fill password buffer after PTY session completes (success or failure)
    passwordBuffer.fill(0);
  }
}
