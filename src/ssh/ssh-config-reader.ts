/**
 * SSH config resolver — uses `ssh -G <host>` to parse ~/.ssh/config
 * (including Include directives, Match blocks, and Host patterns) via the
 * OpenSSH binary itself. This is the canonical way to resolve SSH config
 * without re-implementing the full ssh_config(5) grammar.
 *
 * Falls back gracefully when the ssh binary is unavailable or the config
 * does not exist.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveSshBin } from '../utils/cli-resolver.js';

const execFileAsync = promisify(execFile);

export interface SshConfigValues {
  /** Resolved HostName (may differ from the alias passed in). */
  hostname: string;
  /** User directive from ssh config. */
  user?: string;
  /** Port (default 22 when not in config). */
  port: number;
  /** Resolved identity files (may include ~ paths). */
  identityFiles: string[];
  /** ProxyJump value (e.g. "bastion.example.com"). */
  proxyJump?: string;
  /** ProxyCommand value. */
  proxyCommand?: string;
  /** ConnectTimeout in seconds from config. */
  connectTimeout?: number;
}

/**
 * Resolve ~/.ssh/config for `host` using `ssh -G <host>`.
 *
 * Returns `null` when the ssh binary is not found, `ssh -G` fails (e.g.
 * no config file, or an older SSH version without -G), or the call times out.
 * Callers should treat null as "no config available" and proceed with
 * explicit parameters only.
 */
export async function resolveSshConfig(host: string): Promise<SshConfigValues | null> {
  let sshBin: string;
  try {
    sshBin = await resolveSshBin();
  } catch {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(sshBin, ['-G', host], {
      timeout: 5_000,
      // Never inherit parent env for security — only pass HOME so ssh can find ~/.ssh/config
      env: {
        HOME: process.env.HOME ?? process.env.USERPROFILE ?? '',
        PATH: process.env.PATH ?? '',
        // Windows compat
        USERPROFILE: process.env.USERPROFILE,
        HOMEDRIVE: process.env.HOMEDRIVE,
        HOMEPATH: process.env.HOMEPATH,
        SystemRoot: process.env.SystemRoot,
      } as Record<string, string>,
    });
    return parseSshGOutput(stdout, host);
  } catch {
    // ssh -G is not fatal — just means we have no config to apply
    return null;
  }
}

/**
 * Parse the key-value output of `ssh -G <host>`.
 *
 * `ssh -G` emits one "key value" pair per line (lower-cased keys).
 * Multi-value keys like `identityfile` may appear multiple times.
 */
function parseSshGOutput(output: string, originalHost: string): SshConfigValues {
  const lines = output.split('\n');

  const get = (key: string): string | undefined => {
    const lower = key.toLowerCase();
    const line = lines.find(l => l.toLowerCase().startsWith(lower + ' '));
    return line ? line.slice(lower.length + 1).trim() : undefined;
  };

  const getAll = (key: string): string[] => {
    const lower = key.toLowerCase();
    return lines
      .filter(l => l.toLowerCase().startsWith(lower + ' '))
      .map(l => l.slice(lower.length + 1).trim())
      .filter(Boolean);
  };

  const hostname = get('hostname') ?? originalHost;

  const user = get('user') || undefined;

  const portStr = get('port');
  const port = portStr ? parseInt(portStr, 10) : 22;

  // ssh -G may emit "identityfile none" when no identity is configured
  const identityFiles = getAll('identityfile').filter(f => f !== 'none' && f !== '');

  const proxyJump = get('proxyjump');
  // "none" means explicitly disabled
  const resolvedProxyJump = proxyJump && proxyJump.toLowerCase() !== 'none' ? proxyJump : undefined;

  const proxyCommand = get('proxycommand');
  const resolvedProxyCommand =
    proxyCommand && proxyCommand.toLowerCase() !== 'none' ? proxyCommand : undefined;

  const connectTimeoutStr = get('connecttimeout');
  const connectTimeout =
    connectTimeoutStr && connectTimeoutStr !== '0'
      ? parseInt(connectTimeoutStr, 10)
      : undefined;

  return {
    hostname,
    user,
    port,
    identityFiles,
    proxyJump: resolvedProxyJump,
    proxyCommand: resolvedProxyCommand,
    connectTimeout,
  };
}
