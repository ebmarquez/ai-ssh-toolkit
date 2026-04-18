/**
 * credential_get tool handler — retrieves credential metadata for a given ref.
 *
 * Returns username and availability status. NEVER returns the password.
 */

import type { CredentialMetadata } from '../credentials/backend.js';
import type { CredentialRegistry } from '../credentials/registry.js';

export interface CredentialGetInput {
  ref: string;
  backend?: string;
}

export async function credentialGet(
  registry: CredentialRegistry,
  input: CredentialGetInput
): Promise<CredentialMetadata> {
  const { ref, backend: backendName = 'google-secret-manager' } = input;

  const backend = registry.getBackend(backendName);
  const available = await backend.isAvailable();
  if (!available) {
    throw new Error(
      `Credential backend "${backendName}" is not available in this environment. ` +
      'Ensure the required CLI tools and authentication are configured.'
    );
  }

  return registry.getMetadata(backendName, ref);
}
