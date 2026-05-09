/**
 * ssh_host_info tool handler — reconnaissance tool that retrieves SSH host
 * information (banner, OS hint, host key fingerprints) without authentication.
 */

import { tcpBannerProbe } from './ssh-check.js';
import { scanHostKeys, detectOsHint } from '../security/host-key-scanner.js';
import { resolveSshConfig } from '../ssh/ssh-config-reader.js';
import type { StoredFingerprint } from '../security/host-key-store.js';

export interface SshHostInfoInput {
  host: string;
  port?: number;
  timeout_ms?: number;
  use_ssh_config?: boolean;
}

export interface SshHostInfoResult {
  host: string;
  port: number;
  banner: string | null;
  os_hint: string | null;
  fingerprints: StoredFingerprint[];
  keyscan_error?: string;
  banner_error?: string;
}

export async function sshHostInfo(
  input: SshHostInfoInput,
): Promise<SshHostInfoResult> {
  const { host, timeout_ms = 5000, use_ssh_config = true } = input;
  let { port } = input;

  if (!host) throw new Error('host is required');

  // Resolve SSH config for the alias
  if (use_ssh_config) {
    const cfg = await resolveSshConfig(host);
    if (cfg) {
      port ??= cfg.port !== 22 ? cfg.port : undefined;
    }
  }

  const resolvedPort = port ?? 22;
  const timeoutSec = Math.max(1, Math.ceil(timeout_ms / 1000));

  // Run banner probe and keyscan in parallel
  const [bannerResult, keyscanResult] = await Promise.allSettled([
    tcpBannerProbe(host, resolvedPort, timeout_ms, true),
    scanHostKeys({ host, port: resolvedPort, timeoutSeconds: timeoutSec }),
  ]);

  const banner = bannerResult.status === 'fulfilled'
    ? bannerResult.value.banner ?? null
    : null;
  const bannerError = bannerResult.status === 'rejected'
    ? String((bannerResult.reason as Error).message ?? bannerResult.reason)
    : undefined;

  const fingerprints = keyscanResult.status === 'fulfilled'
    ? keyscanResult.value
    : [];
  const keyscanError = keyscanResult.status === 'rejected'
    ? String((keyscanResult.reason as Error).message ?? keyscanResult.reason)
    : undefined;

  return {
    host,
    port: resolvedPort,
    banner,
    os_hint: detectOsHint(banner ?? undefined),
    fingerprints,
    ...(keyscanError ? { keyscan_error: keyscanError } : {}),
    ...(bannerError ? { banner_error: bannerError } : {}),
  };
}
