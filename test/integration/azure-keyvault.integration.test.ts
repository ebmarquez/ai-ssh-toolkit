/**
 * Live integration test for AzureKeyVaultBackend.
 *
 * Requires:
 *   - AZURE_KV_ENABLED=true
 *   - az CLI authenticated (az login or SP via ~/.config/azure/sp-login.sh)
 *   - AZURE_KV_NAME env var (defaults to 'rg-ut-bw')
 *   - Secret 'surface-aac-1' in the vault with JSON {"username":"eric","password":"..."}
 *
 * Run locally:
 *   AZURE_KV_ENABLED=true AZURE_KV_NAME=rg-ut-bw npx vitest run test/integration/azure-keyvault.integration.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { AzureKeyVaultBackend } from '../../src/credentials/azure-keyvault.js';

const SKIP = process.env.AZURE_KV_ENABLED !== 'true';
const KV_NAME = process.env.AZURE_KV_NAME ?? 'rg-ut-bw';
const SECRET_REF = `${KV_NAME}/surface-aac-1`;

describe.skipIf(SKIP)('AzureKeyVaultBackend — live integration', () => {
  let backend: AzureKeyVaultBackend;

  beforeAll(() => {
    backend = new AzureKeyVaultBackend();
  });

  it('isAvailable() returns true when az CLI is authenticated', async () => {
    const available = await backend.isAvailable();
    expect(available).toBe(true);
  });

  it('getCredential() retrieves username and password from vault', async () => {
    const cred = await backend.getCredential(SECRET_REF);
    expect(cred.username).toBe('eric');
    expect(cred.password).toBeInstanceOf(Buffer);
    expect(cred.password.length).toBeGreaterThan(0);
    // Zero-fill after test
    cred.password.fill(0);
    await backend.cleanup();
  });

  it('getMetadata() returns has_password: true for existing secret', async () => {
    const meta = await backend.getMetadata(SECRET_REF);
    expect(meta.has_password).toBe(true);
    expect(meta.backend).toBe('azure-keyvault');
  });

  it('getCredential() throws for non-existent secret', async () => {
    await expect(backend.getCredential(`${KV_NAME}/does-not-exist-xyz`))
      .rejects.toThrow();
    await backend.cleanup();
  });
});
