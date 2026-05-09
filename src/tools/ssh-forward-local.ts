/**
 * ssh_forward_local tool handler — starts a local (-L) SSH port forward.
 */

import type { CredentialRegistry } from '../credentials/registry.js';
import type { CredentialMap } from '../credentials/credential-map.js';
import { startLocalForward, type ForwardResult } from '../ssh/forward-manager.js';

export interface SshForwardLocalInput {
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

export async function sshForwardLocal(
  registry: CredentialRegistry,
  input: SshForwardLocalInput,
  credentialMap: CredentialMap,
): Promise<ForwardResult> {
  if (!input.host) throw new Error('host is required');
  return startLocalForward(input, registry, credentialMap);
}
