/**
 * credential_list_backends tool handler — lists all registered credential backends
 * and their availability in the current environment.
 */

import { listBackends } from '../credentials/registry.js';

export interface BackendStatus {
  name: string;
  available: boolean;
}

export async function credentialListBackends(): Promise<BackendStatus[]> {
  return listBackends();
}
