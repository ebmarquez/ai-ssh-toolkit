/**
 * credential_list_backends tool handler — lists all registered credential backends
 * and their availability in the current environment.
 */

import type { CredentialRegistry } from '../credentials/registry.js';

export interface BackendStatus {
  name: string;
  available: boolean;
}

export async function credentialListBackends(registry: CredentialRegistry): Promise<BackendStatus[]> {
  return registry.discoverAvailability();
}
