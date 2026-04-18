/**
 * credential_list_backends tool handler — lists all registered credential backends
 * and their availability in the current environment.
 */

import type { BackendStatus, CredentialRegistry } from '../credentials/registry.js';

export async function credentialListBackends(registry: CredentialRegistry): Promise<BackendStatus[]> {
  return registry.discoverAvailability();
}
