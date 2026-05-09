/**
 * ssh_host_key_trust tool — pin or re-pin a host key fingerprint.
 *
 * If fingerprint is provided, pins that specific fingerprint.
 * If omitted, fetches live keys from the host via ssh-keyscan.
 */

import type { HostKeyStore, StoredFingerprint } from '../security/host-key-store.js';
import { scanHostKeys } from '../security/host-key-scanner.js';
import { resolveSshConfig } from '../ssh/ssh-config-reader.js';

export interface SshHostKeyTrustInput {
  host: string;
  port?: number;
  fingerprint?: string;
  key_type?: string;
  use_ssh_config?: boolean;
}

export interface SshHostKeyTrustResult {
  host: string;
  port: number;
  pinned: StoredFingerprint[];
  message: string;
}

export async function sshHostKeyTrust(
  store: HostKeyStore,
  input: SshHostKeyTrustInput,
): Promise<SshHostKeyTrustResult> {
  const { host, fingerprint, key_type, use_ssh_config = true } = input;
  let { port } = input;

  if (!host) throw new Error('host is required');

  if (use_ssh_config) {
    const cfg = await resolveSshConfig(host);
    if (cfg) {
      port ??= cfg.port !== 22 ? cfg.port : undefined;
    }
  }

  const resolvedPort = port ?? 22;

  let fingerprints: StoredFingerprint[];

  if (fingerprint) {
    // Pin a specific fingerprint provided by the user
    const normalizedSha256 = fingerprint.startsWith('SHA256:')
      ? fingerprint
      : `SHA256:${fingerprint}`;
    fingerprints = [{
      type: key_type ?? 'unknown',
      sha256: normalizedSha256,
    }];
  } else {
    // Fetch live keys
    fingerprints = await scanHostKeys({ host, port: resolvedPort });
    if (fingerprints.length === 0) {
      throw new Error(`No host keys retrieved from ${host}:${resolvedPort}. Is the host reachable?`);
    }
  }

  store.pin(host, resolvedPort, fingerprints);

  return {
    host,
    port: resolvedPort,
    pinned: fingerprints,
    message: `Host key(s) pinned for ${host}:${resolvedPort}`,
  };
}
