/**
 * ssh_forward_remote tool handler — starts a remote (-R) SSH port forward.
 */

import type { CredentialRegistry } from '../credentials/registry.js';
import type { CredentialMap } from '../credentials/credential-map.js';
import { startRemoteForward, type ForwardResult } from '../ssh/forward-manager.js';

export interface SshForwardRemoteInput {
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

export async function sshForwardRemote(
  registry: CredentialRegistry,
  input: SshForwardRemoteInput,
  credentialMap: CredentialMap,
): Promise<ForwardResult> {
  if (!input.host) throw new Error('host is required');
  return startRemoteForward(input, registry, credentialMap);
}
