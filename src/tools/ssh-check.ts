/**
 * ssh_check_host tool handler — verifies SSH connectivity to a host without
 * executing commands (uses ssh -q -o BatchMode=yes -o ConnectTimeout=5).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveSshBin } from '../utils/cli-resolver.js';

const execFileAsync = promisify(execFile);

export interface SshCheckInput {
  host: string;
  port?: number;
  username?: string;
  timeout_ms?: number;
}

export interface SshCheckResult {
  reachable: boolean;
  latency_ms: number | null;
  error?: string;
}

export async function sshCheckHost(input: SshCheckInput): Promise<SshCheckResult> {
  const { host, port = 22, username, timeout_ms = 5000 } = input;

  const sshBin = await resolveSshBin();
  const timeoutSec = Math.max(1, Math.ceil(timeout_ms / 1000));

  const target = username ? `${username}@${host}` : host;
  const args = [
    '-q',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${timeoutSec}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(port),
    target,
    'exit',
  ];

  const start = Date.now();
  try {
    await execFileAsync(sshBin, args, { timeout: timeout_ms + 1000 });
    return { reachable: true, latency_ms: Date.now() - start };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Exit code 255 = ssh-level connection failure (host unreachable, refused, etc.)
    // Exit code 0 = connected and exited cleanly
    // Exit code 1 = connected but "exit" command returned non-zero (still means reachable)
    // execFile exposes child exit code on err.code (number); err.status is a fallback
    const error = err as NodeJS.ErrnoException & { code?: number | string; status?: number };
    const code = typeof error.code === 'number' ? error.code : error.status;
    if (code === 1) {
      // Connected — the remote shell returned non-zero, but host is reachable
      return { reachable: true, latency_ms: Date.now() - start };
    }
    return { reachable: false, latency_ms: null, error: msg };
  }
}
