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

const VALID_REF = /^[a-zA-Z0-9/_\-.@:]+$/;

export async function credentialGet(
  registry: CredentialRegistry,
  input: CredentialGetInput
): Promise<CredentialMetadata> {
  const { ref, backend: backendName = 'google-secret-manager' } = input;

  if (!VALID_REF.test(ref)) {
    throw new Error('Invalid credential_ref format');
  }

  const backend = registry.getBackend(backendName);

  try {
    const available = await backend.isAvailable();
    if (!available) {
      process.stderr.write(`Credential backend "${backendName}" unavailable: not available in this environment\n`);
      throw new Error(`Credential backend "${backendName}" failed. Check server logs for details.`);
    }
    return await registry.getMetadata(backendName, ref);
  } finally {
    await backend.cleanup();
  }
}
