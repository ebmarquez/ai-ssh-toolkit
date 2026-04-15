/**
 * Credential backend registry — discovers and manages all available backends.
 */

import { GoogleSecretManagerBackend } from './google-secret-manager.js';
import type { CredentialBackend } from './backend.js';

const ALL_BACKENDS: CredentialBackend[] = [
  new GoogleSecretManagerBackend(),
  // TODO: Add Bitwarden, Azure Key Vault, env backends when implemented
];

/**
 * Get a backend by name.
 */
export function getBackend(name: string): CredentialBackend | undefined {
  return ALL_BACKENDS.find(b => b.name === name);
}

/**
 * List all backends and their availability.
 */
export async function listBackends(): Promise<Array<{ name: string; available: boolean }>> {
  return Promise.all(
    ALL_BACKENDS.map(async b => ({
      name: b.name,
      available: await b.isAvailable(),
    }))
  );
}
