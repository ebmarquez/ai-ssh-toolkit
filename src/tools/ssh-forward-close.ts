/**
 * ssh_forward_close tool handler — closes an active SSH port forward.
 */

import { closeForward } from '../ssh/forward-manager.js';

export interface SshForwardCloseInput {
  forward_id: string;
}

export function sshForwardClose(input: SshForwardCloseInput): { forward_id: string; status: 'closed' } {
  if (!input.forward_id) throw new Error('forward_id is required');
  return closeForward(input.forward_id);
}
