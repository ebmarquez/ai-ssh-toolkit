/**
 * ssh_forward_list tool handler — lists all active SSH port forwards.
 */

import { listForwards, type ForwardEntry } from '../ssh/forward-manager.js';

export function sshForwardList(): ForwardEntry[] {
  return listForwards();
}
