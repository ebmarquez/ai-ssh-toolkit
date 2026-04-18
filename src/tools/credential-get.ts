/**
 * credential_get tool handler — retrieves credential metadata for a given ref.
 *
 * Returns username and availability status. NEVER returns the password.
 */

import { getBackend } from '../credentials/registry.js';
import type { CredentialMetadata } from '../credentials/backend.js';

export interface CredentialGetInput {
  ref: string;
  backend?: string;
}

export async function credentialGet(input: CredentialGetInput): Promise<CredentialMetadata> {
  const { ref, backend: backendName = 'google-secret-manager' } = input;

  const backend = getBackend(backendName);
  if (!backend) {
    throw new Error(`Unknown credential backend: "${backendName}"`);
  }

  const available = await backend.isAvailable();
  if (!available) {
    throw new Error(
      `Credential backend "${backendName}" is not available in this environment. ` +
      'Ensure the required CLI tools and authentication are configured.'
    );
  }

  const metadata = await backend.getMetadata(ref);
  return metadata;
}
