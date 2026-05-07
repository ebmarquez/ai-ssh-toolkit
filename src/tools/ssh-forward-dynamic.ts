/**
 * ssh_forward_dynamic tool handler — starts a dynamic (-D) SOCKS proxy SSH forward.
 */

import type { CredentialRegistry } from '../credentials/registry.js';
import type { CredentialMap } from '../credentials/credential-map.js';
import { startDynamicForward, type ForwardResult } from '../ssh/forward-manager.js';

export interface SshForwardDynamicInput {
  host: string;
  local_port: number;
  username?: string;
  credential_backend?: string;
  credential_ref?: string;
  idle_timeout_seconds?: number;
  use_ssh_config?: boolean;
}

export async function sshForwardDynamic(
  registry: CredentialRegistry,
  input: SshForwardDynamicInput,
  credentialMap: CredentialMap,
): Promise<ForwardResult> {
  if (!input.host) throw new Error('host is required');
  return startDynamicForward(input, registry, credentialMap);
}
