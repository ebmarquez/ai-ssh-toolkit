/**
 * Unit tests for GoogleSecretManagerBackend
 *
 * Mocks the promisified execFile so no real gcloud CLI or GCP project is needed.
 * Key focus: base64 decode of payload.data (the bug fixed in this PR).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted ensures the mock fn is created before vi.mock factories run
const mockExecFileAsync = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: (_fn: unknown) => mockExecFileAsync,
  };
});

import { GoogleSecretManagerBackend } from '../../src/credentials/google-secret-manager.js';

// ---- mock helper ----------------------------------------------------------
// The backend calls: execFileAsync(cmd, argv, opts?)
// We match on argv (joined) to return the right stdout.

function setupMock(map: Record<string, string | Error>) {
  mockExecFileAsync.mockImplementation(
    (_cmd: string, argv: string[], _opts?: object) => {
      const key = argv.join(' ');
      // 'which gcloud' resolution — always succeeds
      if (_cmd === 'which') {
        return Promise.resolve({ stdout: '/usr/bin/gcloud', stderr: '' });
      }
      const entry = Object.entries(map).find(([k]) => key.includes(k));
      if (entry) {
        const val = entry[1];
        if (val instanceof Error) return Promise.reject(val);
        return Promise.resolve({ stdout: val, stderr: '' });
      }
      // Fail explicitly so unexpected calls surface in tests
      return Promise.reject(new Error(`Unexpected execFileAsync call: ${_cmd} ${key}`));
    },
  );
}
// --------------------------------------------------------------------------

describe('GoogleSecretManagerBackend', () => {
  let backend: GoogleSecretManagerBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new GoogleSecretManagerBackend();
    delete process.env['GCLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_PROJECT'];
  });

  afterEach(() => {
    delete process.env['GCLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_PROJECT'];
  });

  // ── isAvailable ──────────────────────────────────────────────────────────

  describe('isAvailable', () => {
    it('returns true when gcloud auth succeeds', async () => {
      setupMock({ 'auth print-access-token': 'ya29.token' });
      expect(await backend.isAvailable()).toBe(true);
    });

    it('returns false when gcloud auth fails', async () => {
      mockExecFileAsync.mockRejectedValue(new Error('gcloud not found'));
      expect(await backend.isAvailable()).toBe(false);
    });
  });

  // ── getCredential - base64 decode ────────────────────────────────────────

  describe('getCredential - base64 decode', () => {
    it('decodes base64 password from payload.data', async () => {
      const rawPassword = 'supersecret';
      const b64Password = Buffer.from(rawPassword).toString('base64');

      setupMock({
        'versions access latest --secret my-secret --project my-project': b64Password,
        'my-secret-username': new Error('not found'),
      });

      const result = await backend.getCredential('my-project/my-secret');

      expect(result.password.toString('utf-8')).toBe(rawPassword);
      expect(result.username).toBe('');
    });

    it('decodes base64 username from paired secret', async () => {
      const rawPassword = 'mypassword';
      const rawUsername = 'admin';
      const b64Password = Buffer.from(rawPassword).toString('base64');
      const b64Username = Buffer.from(rawUsername).toString('base64');

      setupMock({
        'versions access latest --secret my-creds --project proj': b64Password,
        'my-creds-username': b64Username,
      });

      const result = await backend.getCredential('proj/my-creds');

      expect(result.password.toString('utf-8')).toBe(rawPassword);
      expect(result.username).toBe(rawUsername);
    });

    it('handles specific version in ref (project/secret/version)', async () => {
      const b64 = Buffer.from('versioned-pass').toString('base64');
      const b64User = Buffer.from('versioned-user').toString('base64');

      setupMock({
        'versions access 3 --secret my-secret --project my-project': b64,
        // username secret should also be fetched with version 3, not latest
        'versions access 3 --secret my-secret-username': b64User,
      });

      const result = await backend.getCredential('my-project/my-secret/3');
      expect(result.password.toString('utf-8')).toBe('versioned-pass');
      expect(result.username).toBe('versioned-user');
    });

    it('returns a Buffer, not a raw base64 string', async () => {
      const rawPassword = 'p@$$w0rd!';
      const b64 = Buffer.from(rawPassword).toString('base64');

      setupMock({
        'versions access latest --secret s --project p': b64,
        's-username': new Error('not found'),
      });

      const result = await backend.getCredential('p/s');
      expect(Buffer.isBuffer(result.password)).toBe(true);
      expect(result.password.toString('utf-8')).toBe(rawPassword);
      // Must NOT be the raw base64 string
      expect(result.password.toString('utf-8')).not.toBe(b64);
    });
  });

  // ── parseRef / ref formats ───────────────────────────────────────────────

  describe('parseRef / ref formats', () => {
    it('throws if ref has no project and GCLOUD_PROJECT is not set', async () => {
      setupMock({});
      await expect(backend.getCredential('just-secret')).rejects.toThrow('GCLOUD_PROJECT');
    });

    it('uses GCLOUD_PROJECT env var for single-part ref', async () => {
      process.env['GCLOUD_PROJECT'] = 'env-project';
      const b64 = Buffer.from('envpass').toString('base64');

      setupMock({
        'versions access latest --secret just-secret --project env-project': b64,
        'just-secret-username': new Error('not found'),
      });

      const result = await backend.getCredential('just-secret');
      expect(result.password.toString('utf-8')).toBe('envpass');
    });

    it('uses GOOGLE_CLOUD_PROJECT env var as fallback', async () => {
      process.env['GOOGLE_CLOUD_PROJECT'] = 'gcp-project';
      const b64 = Buffer.from('gcppass').toString('base64');

      setupMock({
        'versions access latest --secret my-secret --project gcp-project': b64,
        'my-secret-username': new Error('not found'),
      });

      const result = await backend.getCredential('my-secret');
      expect(result.password.toString('utf-8')).toBe('gcppass');
    });

    it('throws for invalid ref with too many parts', async () => {
      setupMock({});
      await expect(backend.getCredential('a/b/c/d')).rejects.toThrow('Invalid Google Secret Manager reference');
    });
  });

  // ── getMetadata ───────────────────────────────────────────────────────────

  describe('getMetadata', () => {
    it('returns metadata with has_password=true', async () => {
      const b64Username = Buffer.from('eric').toString('base64');

      setupMock({
        'versions describe latest --secret my-secret --project my-project': 'state: ENABLED',
        'my-secret-username': b64Username,
      });

      const meta = await backend.getMetadata('my-project/my-secret');
      expect(meta.has_password).toBe(true);
      expect(meta.backend).toBe('google-secret-manager');
      expect(meta.username).toBe('eric');
    });
  });

  // ── cleanup ───────────────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('resolves without error', async () => {
      await expect(backend.cleanup()).resolves.toBeUndefined();
    });
  });
});
