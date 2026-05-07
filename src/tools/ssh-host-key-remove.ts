/**
 * ssh_host_key_remove tool — forget a pinned host key.
 */

import type { HostKeyStore } from '../security/host-key-store.js';

export interface SshHostKeyRemoveInput {
  host: string;
  port?: number;
}

export interface SshHostKeyRemoveResult {
  host: string;
  port: number;
  removed: boolean;
  message: string;
}

export function sshHostKeyRemove(
  store: HostKeyStore,
  input: SshHostKeyRemoveInput,
): SshHostKeyRemoveResult {
  const { host, port = 22 } = input;

  if (!host) throw new Error('host is required');

  const removed = store.remove(host, port);

  return {
    host,
    port,
    removed,
    message: removed
      ? `Host key for ${host}:${port} removed`
      : `No pinned key found for ${host}:${port}`,
  };
}
