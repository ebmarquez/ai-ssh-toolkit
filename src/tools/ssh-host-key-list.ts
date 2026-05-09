/**
 * ssh_host_key_list tool — list all pinned host key fingerprints.
 */

import type { HostKeyStore } from '../security/host-key-store.js';

export interface SshHostKeyListResult {
  hosts: Record<string, {
    fingerprints: { type: string; sha256: string }[];
    first_seen: string;
    last_seen: string;
  }>;
  store_path: string;
}

export function sshHostKeyList(store: HostKeyStore): SshHostKeyListResult {
  return {
    hosts: store.list(),
    store_path: store.getFilePath(),
  };
}
