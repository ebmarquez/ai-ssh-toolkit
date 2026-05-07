/**
 * SSH port forward manager — spawns and tracks background ssh -N processes
 * for local (-L), remote (-R), and dynamic (-D) port forwarding.
 *
 * Uses BatchMode=yes + ExitOnForwardFailure=yes so that forwarding is
 * limited to key/agent-based authentication (no interactive password prompts).
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { resolveSshBin } from '../utils/cli-resolver.js';
import { resolveSshConfig } from './ssh-config-reader.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type ForwardType = 'local' | 'remote' | 'dynamic';

export interface ForwardEntry {
  forward_id: string;
  type: ForwardType;
  host: string;
  status: 'active' | 'closed';
  local_port: number;
  remote_host?: string;
  remote_port?: number;
  created_at: string;
}

interface InternalForwardEntry extends ForwardEntry {
  process: ChildProcess;
  timeout_timer: ReturnType<typeof setTimeout> | null;
  stderr_buffer: string;
}

export interface ForwardLocalInput {
  host: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
  username?: string;
  credential_backend?: string;
  credential_ref?: string;
  idle_timeout_seconds?: number;
  use_ssh_config?: boolean;
}

export interface ForwardRemoteInput {
  host: string;
  remote_port: number;
  local_host: string;
  local_port: number;
  username?: string;
  credential_backend?: string;
  credential_ref?: string;
  idle_timeout_seconds?: number;
  use_ssh_config?: boolean;
}

export interface ForwardDynamicInput {
  host: string;
  local_port: number;
  username?: string;
  credential_backend?: string;
  credential_ref?: string;
  idle_timeout_seconds?: number;
  use_ssh_config?: boolean;
}

export interface ForwardResult {
  forward_id: string;
  status: 'active' | 'closed';
  local_port: number;
  remote_host?: string;
  remote_port?: number;
}

// ── Forward store ────────────────────────────────────────────────────────────

const forwards = new Map<string, InternalForwardEntry>();

// Exposed for testing: allow injecting a custom spawn function
export type SpawnFn = typeof spawn;
let _spawnFn: SpawnFn = spawn;

export function _setSpawnFn(fn: SpawnFn): void {
  _spawnFn = fn;
}
export function _resetSpawnFn(): void {
  _spawnFn = spawn;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildFilteredEnv(): Record<string, string> {
  return {
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? '',
    PATH: process.env.PATH ?? '',
    USERPROFILE: process.env.USERPROFILE ?? '',
    HOMEDRIVE: process.env.HOMEDRIVE ?? '',
    HOMEPATH: process.env.HOMEPATH ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? '',
  };
}

function finalizeForward(id: string): void {
  const entry = forwards.get(id);
  if (!entry) return;

  if (entry.timeout_timer) {
    clearTimeout(entry.timeout_timer);
    entry.timeout_timer = null;
  }

  entry.status = 'closed';

  try {
    if (entry.process.pid && !entry.process.killed) {
      entry.process.kill('SIGTERM');
    }
  } catch {
    // Process may already be dead
  }

  forwards.delete(id);
}

/**
 * Resolve username from credential inputs and SSH config.
 * Returns the resolved username (may be empty if none found).
 */
async function resolveUsername(
  input: { host: string; username?: string; credential_ref?: string; credential_backend?: string; use_ssh_config?: boolean },
  registry?: { getBackend(name: string): { isAvailable(): Promise<boolean>; getCredential(ref: string): Promise<{ username: string; password: Buffer }>; cleanup(): Promise<void> } },
  credentialMap?: { resolve(host: string): { backend: string; ref?: string; username?: string } | null },
): Promise<string> {
  let { credential_ref, credential_backend } = input;
  let mappedUsername: string | undefined;

  // Credential map fallback
  if (credential_backend === undefined && credential_ref === undefined && credentialMap) {
    const mapped = credentialMap.resolve(input.host);
    if (mapped) {
      credential_backend = mapped.backend;
      credential_ref = mapped.ref;
      mappedUsername = mapped.username;
    }
  }

  // Resolve username from credential backend (username only, no password for forwarding)
  let credentialUsername: string | undefined;
  if (credential_ref !== undefined && registry) {
    const backendName = credential_backend ?? 'google-secret-manager';
    const backend = registry.getBackend(backendName);
    try {
      const available = await backend.isAvailable();
      if (available) {
        const cred = await backend.getCredential(credential_ref);
        credentialUsername = cred.username || undefined;
        // Zero password immediately — we don't use passwords for forwarding
        cred.password.fill(0);
      }
    } finally {
      await backend.cleanup();
    }
  }

  // Priority: explicit username > credential username > mapped username > ssh config
  let resolvedUsername = input.username ?? credentialUsername ?? mappedUsername ?? '';

  if (!resolvedUsername && (input.use_ssh_config ?? true)) {
    const config = await resolveSshConfig(input.host);
    if (config?.user) {
      resolvedUsername = config.user;
    }
  }

  return resolvedUsername;
}

// ── Core operations ──────────────────────────────────────────────────────────

/**
 * Start a local port forward (-L local_port:remote_host:remote_port).
 */
export async function startLocalForward(
  input: ForwardLocalInput,
  registry?: Parameters<typeof resolveUsername>[1],
  credentialMap?: Parameters<typeof resolveUsername>[2],
): Promise<ForwardResult> {
  const username = await resolveUsername(input, registry, credentialMap);
  const forwardSpec = `${input.local_port}:${input.remote_host}:${input.remote_port}`;
  return startForwardProcess('local', input.host, username, ['-L', forwardSpec], {
    local_port: input.local_port,
    remote_host: input.remote_host,
    remote_port: input.remote_port,
    idle_timeout_seconds: input.idle_timeout_seconds,
    use_ssh_config: input.use_ssh_config,
  });
}

/**
 * Start a remote port forward (-R remote_port:local_host:local_port).
 */
export async function startRemoteForward(
  input: ForwardRemoteInput,
  registry?: Parameters<typeof resolveUsername>[1],
  credentialMap?: Parameters<typeof resolveUsername>[2],
): Promise<ForwardResult> {
  const username = await resolveUsername(input, registry, credentialMap);
  const forwardSpec = `${input.remote_port}:${input.local_host}:${input.local_port}`;
  return startForwardProcess('remote', input.host, username, ['-R', forwardSpec], {
    local_port: input.local_port,
    remote_host: input.local_host,
    remote_port: input.remote_port,
    idle_timeout_seconds: input.idle_timeout_seconds,
    use_ssh_config: input.use_ssh_config,
  });
}

/**
 * Start a dynamic SOCKS forward (-D local_port).
 */
export async function startDynamicForward(
  input: ForwardDynamicInput,
  registry?: Parameters<typeof resolveUsername>[1],
  credentialMap?: Parameters<typeof resolveUsername>[2],
): Promise<ForwardResult> {
  const username = await resolveUsername(input, registry, credentialMap);
  return startForwardProcess('dynamic', input.host, username, ['-D', String(input.local_port)], {
    local_port: input.local_port,
    idle_timeout_seconds: input.idle_timeout_seconds,
    use_ssh_config: input.use_ssh_config,
  });
}

async function startForwardProcess(
  type: ForwardType,
  host: string,
  username: string,
  forwardArgs: string[],
  opts: {
    local_port: number;
    remote_host?: string;
    remote_port?: number;
    idle_timeout_seconds?: number;
    use_ssh_config?: boolean;
  },
): Promise<ForwardResult> {
  const sshBin = await resolveSshBin();
  const timeoutSeconds = opts.idle_timeout_seconds ?? 3600;

  const args: string[] = [
    '-N',                           // No remote command
    '-o', 'BatchMode=yes',          // No interactive prompts
    '-o', 'ExitOnForwardFailure=yes', // Fail if forward can't be established
    '-o', 'StrictHostKeyChecking=accept-new',
    ...forwardArgs,
  ];

  if (username) {
    args.push('-l', username);
  }

  if (opts.use_ssh_config === false) {
    args.push('-F', '/dev/null');
  }

  args.push('--', host);

  const forward_id = randomUUID();

  const child = _spawnFn(sshBin, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: buildFilteredEnv(),
    detached: false,
  });

  // Accumulate stderr (bounded)
  let stderrBuf = '';
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBuf.length < 4096) {
        stderrBuf += chunk.toString('utf-8').slice(0, 4096 - stderrBuf.length);
      }
    });
  }

  const entry: InternalForwardEntry = {
    forward_id,
    type,
    host,
    status: 'active',
    local_port: opts.local_port,
    remote_host: opts.remote_host,
    remote_port: opts.remote_port,
    created_at: new Date().toISOString(),
    process: child,
    timeout_timer: null,
    stderr_buffer: '',
  };

  forwards.set(forward_id, entry);

  // Auto-close on process exit
  child.on('close', () => {
    entry.stderr_buffer = stderrBuf;
    finalizeForward(forward_id);
  });

  // Wait briefly for the process to stabilize (catch immediate failures)
  const startupError = await new Promise<string | null>((resolve) => {
    const stabilize = setTimeout(() => {
      resolve(null);
    }, 500);

    child.on('close', (code) => {
      clearTimeout(stabilize);
      resolve(stderrBuf || `ssh exited with code ${code}`);
    });

    child.on('error', (err) => {
      clearTimeout(stabilize);
      resolve(err.message);
    });
  });

  if (startupError) {
    finalizeForward(forward_id);
    throw new Error(`Forward failed: ${startupError}`);
  }

  // Set max lifetime timer
  if (timeoutSeconds > 0) {
    entry.timeout_timer = setTimeout(() => {
      finalizeForward(forward_id);
    }, timeoutSeconds * 1000);
    // Don't prevent Node from exiting
    if (entry.timeout_timer && typeof entry.timeout_timer === 'object' && 'unref' in entry.timeout_timer) {
      entry.timeout_timer.unref();
    }
  }

  return {
    forward_id,
    status: 'active',
    local_port: opts.local_port,
    remote_host: opts.remote_host,
    remote_port: opts.remote_port,
  };
}

/**
 * Close an active forward by ID.
 */
export function closeForward(forward_id: string): { forward_id: string; status: 'closed' } {
  const entry = forwards.get(forward_id);
  if (!entry) {
    throw new Error(`No active forward with id: ${forward_id}`);
  }
  finalizeForward(forward_id);
  return { forward_id, status: 'closed' };
}

/**
 * List all active forwards.
 */
export function listForwards(): ForwardEntry[] {
  return Array.from(forwards.values()).map((e) => ({
    forward_id: e.forward_id,
    type: e.type,
    host: e.host,
    status: e.status,
    local_port: e.local_port,
    remote_host: e.remote_host,
    remote_port: e.remote_port,
    created_at: e.created_at,
  }));
}

/**
 * Destroy all active forwards — used during shutdown.
 */
export function destroyAllForwards(): void {
  for (const id of Array.from(forwards.keys())) {
    finalizeForward(id);
  }
}
