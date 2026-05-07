/**
 * SCP/SFTP file transfer tools — ssh_upload, ssh_download, ssh_sftp_list.
 *
 * All three tools use the `sftp` binary in batch mode for consistency.
 * Password auth is handled via `sshpass -d <fd>` when a credential is resolved.
 */

import { spawn } from 'child_process';
import { resolveCliPath } from '../utils/cli-resolver.js';
import { resolveSshConfig } from '../ssh/ssh-config-reader.js';
import type { CredentialRegistry } from '../credentials/registry.js';
import type { CredentialMap } from '../credentials/credential-map.js';

// ── Shared types ─────────────────────────────────────────────────────────────

export interface SshTransferInput {
  host: string;
  username?: string;
  credential_ref?: string;
  credential_backend?: string;
  port?: number;
  timeout_ms?: number;
}

export interface SshUploadInput extends SshTransferInput {
  local_path: string;
  remote_path: string;
}

export interface SshDownloadInput extends SshTransferInput {
  remote_path: string;
  local_path: string;
}

export interface SshSftpListInput extends SshTransferInput {
  remote_path: string;
  recursive?: boolean;
}

export interface SftpEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;
  permissions?: string;
  modified?: string;
}

export interface SftpListResult {
  path: string;
  entries: SftpEntry[];
  truncated: boolean;
}

export interface TransferResult {
  success: boolean;
  local_path: string;
  remote_path: string;
  duration_ms: number;
  message?: string;
}

const MAX_LIST_ENTRIES = 200;

// ── Path validation ──────────────────────────────────────────────────────────

function validatePath(path: string, label: string): void {
  if (!path || !path.trim()) {
    throw new Error(`${label} is required`);
  }
  if (/[\r\n]/.test(path)) {
    throw new Error(`${label} must not contain newline characters`);
  }
}

// ── Environment allowlist ────────────────────────────────────────────────────

function buildSshEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  const allowlist = [
    'HOME', 'PATH', 'TERM', 'LANG', 'LC_ALL',
    'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot',
  ];
  for (const key of allowlist) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.TERM ??= 'xterm-color';
  if (extra) Object.assign(env, extra);
  return env;
}

// ── Credential resolution ────────────────────────────────────────────────────

interface ResolvedAuth {
  username: string;
  password: Buffer<ArrayBufferLike>;
}

async function resolveAuth(
  registry: CredentialRegistry,
  credentialMap: CredentialMap,
  host: string,
  credentialBackend?: string,
  credentialRef?: string,
  explicitUsername?: string,
): Promise<ResolvedAuth> {
  let backend = credentialBackend;
  let ref = credentialRef;
  let mappedUsername: string | undefined;

  if (backend === undefined && ref === undefined) {
    const mapped = credentialMap.resolve(host);
    if (mapped) {
      backend = mapped.backend;
      ref = mapped.ref;
      mappedUsername = mapped.username;
    }
  }

  let resolvedUsername = explicitUsername ?? mappedUsername ?? '';
  let passwordBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  if (ref !== undefined) {
    if (!ref.trim()) {
      throw new Error('credential_ref cannot be empty');
    }
    const backendName = backend ?? 'google-secret-manager';
    const backendInst = registry.getBackend(backendName);
    try {
      const available = await backendInst.isAvailable();
      if (!available) {
        throw new Error(`Credential backend "${backendName}" is not available`);
      }
      const cred = await backendInst.getCredential(ref);
      resolvedUsername = cred.username || resolvedUsername;
      passwordBuffer = Buffer.from(cred.password) as Buffer<ArrayBufferLike>;
      cred.password.fill(0);
    } finally {
      await backendInst.cleanup();
    }
  }

  // Resolve SSH config for username if still missing
  if (!resolvedUsername) {
    const cfg = await resolveSshConfig(host);
    if (cfg?.user) {
      resolvedUsername = cfg.user;
    }
  }

  if (!resolvedUsername) {
    throw new Error(
      'username is required. Provide username, a credential_ref with a username, ' +
      'or add a User directive to ~/.ssh/config for this host.',
    );
  }

  return { username: resolvedUsername, password: passwordBuffer };
}

// ── SFTP subprocess runner ───────────────────────────────────────────────────

interface SftpRunOptions {
  host: string;
  username: string;
  password: Buffer<ArrayBufferLike>;
  port?: number;
  batchCommands: string;
  timeoutMs: number;
}

/**
 * Run sftp in batch mode. Returns { stdout, stderr }.
 * Throws on non-zero exit or timeout.
 */
export async function runSftp(opts: SftpRunOptions): Promise<{ stdout: string; stderr: string }> {
  const { host, username, password, port, batchCommands, timeoutMs } = opts;
  const hasPassword = password.length > 0;

  const sftpArgs: string[] = [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
    '-o', 'NumberOfPasswordPrompts=1',
    '-b', '-',  // read batch commands from stdin
  ];
  if (port !== undefined && port !== 22) {
    sftpArgs.push('-P', String(port));
  }
  sftpArgs.push(`${username}@${host}`);

  let cmd: string;
  let args: string[];
  const env = buildSshEnv();

  if (hasPassword) {
    // Use sshpass to provide password
    const sshpassBin = resolveCliPath('sshpass');
    // Pass password via environment (SSHPASS)
    env.SSHPASS = password.toString('utf-8');
    cmd = sshpassBin;
    args = ['-e', resolveCliPath('sftp'), ...sftpArgs];
  } else {
    cmd = resolveCliPath('sftp');
    args = ['-o', 'BatchMode=yes', ...sftpArgs];
  }

  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        child.kill('SIGTERM');
        reject(new Error(`SFTP operation timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('error', (err) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        reject(new Error(`Failed to spawn sftp: ${err.message}`));
      }
    });

    child.on('close', (code) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          const msg = stderr.trim() || `sftp exited with code ${code}`;
          reject(new Error(msg));
        }
      }
    });

    // Write batch commands to stdin and close
    child.stdin.write(batchCommands + '\n');
    child.stdin.end();
  });
}

// ── Quote path for SFTP batch command ────────────────────────────────────────

function sftpQuote(p: string): string {
  // Wrap in double quotes, escaping embedded backslashes and double quotes
  return '"' + p.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// ── Tool handlers ────────────────────────────────────────────────────────────

export async function sshUpload(
  registry: CredentialRegistry,
  input: SshUploadInput,
  credentialMap: CredentialMap,
): Promise<TransferResult> {
  if (!input.host) throw new Error('host is required');
  validatePath(input.local_path, 'local_path');
  validatePath(input.remote_path, 'remote_path');

  const start = Date.now();
  const auth = await resolveAuth(
    registry, credentialMap, input.host,
    input.credential_backend, input.credential_ref, input.username,
  );

  try {
    const batchCmd = `put ${sftpQuote(input.local_path)} ${sftpQuote(input.remote_path)}`;
    await runSftp({
      host: input.host,
      username: auth.username,
      password: auth.password,
      port: input.port,
      batchCommands: batchCmd,
      timeoutMs: input.timeout_ms ?? 30000,
    });

    return {
      success: true,
      local_path: input.local_path,
      remote_path: input.remote_path,
      duration_ms: Date.now() - start,
    };
  } finally {
    auth.password.fill(0);
  }
}

export async function sshDownload(
  registry: CredentialRegistry,
  input: SshDownloadInput,
  credentialMap: CredentialMap,
): Promise<TransferResult> {
  if (!input.host) throw new Error('host is required');
  validatePath(input.remote_path, 'remote_path');
  validatePath(input.local_path, 'local_path');

  const start = Date.now();
  const auth = await resolveAuth(
    registry, credentialMap, input.host,
    input.credential_backend, input.credential_ref, input.username,
  );

  try {
    const batchCmd = `get ${sftpQuote(input.remote_path)} ${sftpQuote(input.local_path)}`;
    await runSftp({
      host: input.host,
      username: auth.username,
      password: auth.password,
      port: input.port,
      batchCommands: batchCmd,
      timeoutMs: input.timeout_ms ?? 30000,
    });

    return {
      success: true,
      local_path: input.local_path,
      remote_path: input.remote_path,
      duration_ms: Date.now() - start,
    };
  } finally {
    auth.password.fill(0);
  }
}

export async function sshSftpList(
  registry: CredentialRegistry,
  input: SshSftpListInput,
  credentialMap: CredentialMap,
): Promise<SftpListResult> {
  if (!input.host) throw new Error('host is required');
  validatePath(input.remote_path, 'remote_path');

  const auth = await resolveAuth(
    registry, credentialMap, input.host,
    input.credential_backend, input.credential_ref, input.username,
  );

  try {
    const lsFlag = input.recursive ? '-Rla' : '-la';
    const batchCmd = `ls ${lsFlag} ${sftpQuote(input.remote_path)}`;
    const { stdout } = await runSftp({
      host: input.host,
      username: auth.username,
      password: auth.password,
      port: input.port,
      batchCommands: batchCmd,
      timeoutMs: input.timeout_ms ?? 30000,
    });

    const entries = parseSftpListing(stdout);
    const truncated = entries.length > MAX_LIST_ENTRIES;
    return {
      path: input.remote_path,
      entries: truncated ? entries.slice(0, MAX_LIST_ENTRIES) : entries,
      truncated,
    };
  } finally {
    auth.password.fill(0);
  }
}

// ── SFTP ls output parser ────────────────────────────────────────────────────

/**
 * Parse OpenSSH `ls -la` output lines into structured entries.
 *
 * Expected format per line:
 *   -rw-r--r--    1 user  group     1234 Jan  1 12:00 filename
 *   drwxr-xr-x    2 user  group     4096 Jan  1 12:00 dirname
 *   lrwxrwxrwx    1 user  group       10 Jan  1 12:00 link -> target
 *
 * Best-effort parsing — unparseable lines are skipped.
 */
export function parseSftpListing(output: string): SftpEntry[] {
  const entries: SftpEntry[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip "total N" header and directory headers for recursive listings
    if (/^total\s+\d+/i.test(trimmed)) continue;
    if (trimmed.endsWith(':') && !trimmed.startsWith('-') && !trimmed.startsWith('d') && !trimmed.startsWith('l')) continue;

    // Match ls -la output: permissions links user group size date name
    const match = trimmed.match(
      /^([dlcbps-][rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$/
    );
    if (!match) continue;

    const [, perms, sizeStr, dateStr, nameField] = match;
    const name = nameField.includes(' -> ') ? nameField.split(' -> ')[0] : nameField;

    // Skip . and .. entries
    if (name === '.' || name === '..') continue;

    let type: 'file' | 'directory' | 'symlink';
    if (perms.startsWith('d')) {
      type = 'directory';
    } else if (perms.startsWith('l')) {
      type = 'symlink';
    } else {
      type = 'file';
    }

    entries.push({
      name,
      type,
      size: parseInt(sizeStr, 10),
      permissions: perms,
      modified: dateStr,
    });
  }

  return entries;
}
