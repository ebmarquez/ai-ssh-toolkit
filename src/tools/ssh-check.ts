/**
 * ssh_check_host tool handler — verifies SSH host reachability via TCP + SSH
 * banner probing (default) or optional full auth check.
 *
 * Modes:
 *  - 'tcp'    — TCP connect only
 *  - 'banner' — TCP connect + read SSH banner (default)
 *  - 'auth'   — full ssh binary auth attempt (BatchMode=yes)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as net from 'net';
import { resolveSshBin } from '../utils/cli-resolver.js';
import { resolveSshConfig } from '../ssh/ssh-config-reader.js';
import type { CredentialMap } from '../credentials/credential-map.js';

const execFileAsync = promisify(execFile);

export type SshCheckMode = 'tcp' | 'banner' | 'auth';

export type SshCheckStatus =
  | 'tcp_unreachable'
  | 'ssh_banner_received'
  | 'auth_succeeded'
  | 'auth_failed';

export interface SshCheckInput {
  host: string;
  port?: number;
  username?: string;
  timeout_ms?: number;
  /**
   * Check mode:
   *  - 'tcp'    — TCP connect only
   *  - 'banner' — TCP connect + read SSH banner (default)
   *  - 'auth'   — full ssh binary auth attempt (BatchMode=yes)
   */
  mode?: SshCheckMode;
  /**
   * When true (default), resolve ~/.ssh/config for the given host alias so that
   * ssh_config(5) directives (HostName, User, Port, IdentityFile, ProxyJump, etc.)
   * are applied. Tool arguments always take precedence over config values.
   * Set to false to bypass ssh config lookup entirely.
   */
  use_ssh_config?: boolean;
}

export interface SshCheckResult {
  reachable: boolean;
  status: SshCheckStatus;
  latency_ms: number | null;
  banner?: string;
  error?: string;
}

/**
 * Perform a TCP connect + optional SSH banner read using Node.js net.Socket.
 * Exported for testing (allows injecting a socket factory).
 */
export async function tcpBannerProbe(
  host: string,
  port: number,
  timeoutMs: number,
  readBanner: boolean,
  socketFactory: () => net.Socket = () => new net.Socket(),
): Promise<SshCheckResult> {
  const start = Date.now();

  return new Promise<SshCheckResult>((resolve) => {
    const socket = socketFactory();
    let settled = false;

    const finish = (result: SshCheckResult) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);

    socket.on('timeout', () => {
      finish({
        reachable: false,
        status: 'tcp_unreachable',
        latency_ms: null,
        error: `TCP connection to ${host}:${port} timed out after ${timeoutMs}ms`,
      });
    });

    socket.on('error', (err: Error) => {
      finish({
        reachable: false,
        status: 'tcp_unreachable',
        latency_ms: null,
        error: err.message,
      });
    });

    socket.connect(port, host, () => {
      const latency = Date.now() - start;

      if (!readBanner) {
        finish({
          reachable: true,
          status: 'ssh_banner_received',
          latency_ms: latency,
        });
        return;
      }

      // Wait for the SSH banner (first chunk of data)
      socket.once('data', (data: Buffer) => {
        const raw = data.toString('utf-8').trim();
        const banner = raw.startsWith('SSH-') ? raw.split('\n')[0].trim() : undefined;
        finish({
          reachable: true,
          status: 'ssh_banner_received',
          latency_ms: latency,
          banner,
        });
      });

      // If no data arrives within a reasonable window, still report reachable
      setTimeout(() => {
        finish({
          reachable: true,
          status: 'ssh_banner_received',
          latency_ms: latency,
        });
      }, Math.min(timeoutMs, 3000));
    });
  });
}

/**
 * Perform an auth-level SSH check using the ssh binary with BatchMode=yes.
 */
async function authProbe(
  host: string,
  port: number,
  username: string | undefined,
  timeoutMs: number,
): Promise<SshCheckResult> {
  const sshBin = await resolveSshBin();
  const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));

  const target = username ? `${username}@${host}` : host;
  const args = [
    '-q',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${timeoutSec}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(port),
    '--',
    target,
    'exit',
  ];

  const start = Date.now();
  try {
    await execFileAsync(sshBin, args, { timeout: timeoutMs + 1000 });
    return { reachable: true, status: 'auth_succeeded', latency_ms: Date.now() - start };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const error = err as NodeJS.ErrnoException & { code?: number | string; status?: number };
    const code = typeof error.code === 'number' ? error.code : error.status;
    if (code === 1) {
      // Connected — remote shell returned non-zero, but auth succeeded
      return { reachable: true, status: 'auth_succeeded', latency_ms: Date.now() - start };
    }
    return { reachable: false, status: 'auth_failed', latency_ms: null, error: msg };
  }
}

export async function sshCheckHost(input: SshCheckInput, credentialMap: CredentialMap): Promise<SshCheckResult> {
  const { host, timeout_ms = 5000, use_ssh_config = true, mode = 'banner' } = input;
  let { port, username } = input;

  // Credential map fallback for username resolution
  if (!username) {
    const mapped = credentialMap.resolve(host);
    if (mapped?.username) {
      username = mapped.username;
    }
  }

  if (use_ssh_config) {
    const cfg = await resolveSshConfig(host);
    if (cfg) {
      port ??= cfg.port !== 22 ? cfg.port : undefined;
      username ??= cfg.user;
    }
  }

  const resolvedPort = port ?? 22;

  switch (mode) {
    case 'tcp':
      return tcpBannerProbe(host, resolvedPort, timeout_ms, false);
    case 'banner':
      return tcpBannerProbe(host, resolvedPort, timeout_ms, true);
    case 'auth':
      return authProbe(host, resolvedPort, username, timeout_ms);
  }
}
