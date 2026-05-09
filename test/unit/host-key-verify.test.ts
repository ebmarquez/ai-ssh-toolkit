import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  HostKeyStore,
  type StoredFingerprint,
} from '../../src/security/host-key-store.js';
import { verifyHostKey } from '../../src/security/host-key-verify.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock the scanner so we never run real ssh-keyscan
vi.mock('../../src/security/host-key-scanner.js', () => ({
  scanHostKeys: vi.fn(),
}));

import { scanHostKeys } from '../../src/security/host-key-scanner.js';
const mockScanHostKeys = vi.mocked(scanHostKeys);

function makeFingerprints(): StoredFingerprint[] {
  return [
    { type: 'ssh-ed25519', sha256: 'SHA256:testkey1', public_key: 'AAAA1' },
  ];
}

function makeDifferentFingerprints(): StoredFingerprint[] {
  return [
    { type: 'ssh-ed25519', sha256: 'SHA256:differentkey', public_key: 'BBBB1' },
  ];
}

describe('verifyHostKey', () => {
  let tmpDir: string;
  let store: HostKeyStore;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), 'hkv-test-'));
    store = new HostKeyStore(join(tmpDir, 'known-keys.json'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pins on first connect (TOFU)', async () => {
    const fps = makeFingerprints();
    mockScanHostKeys.mockResolvedValueOnce(fps);

    await verifyHostKey(store, 'new.host', 22);

    const entry = store.lookup('new.host', 22);
    expect(entry).toBeDefined();
    expect(entry!.fingerprints[0].sha256).toBe('SHA256:testkey1');
  });

  it('allows connection when fingerprint matches', async () => {
    const fps = makeFingerprints();
    store.pin('known.host', 22, fps);

    mockScanHostKeys.mockResolvedValueOnce(fps);

    // Should not throw
    await expect(verifyHostKey(store, 'known.host', 22)).resolves.toBeUndefined();
  });

  it('rejects connection on fingerprint mismatch', async () => {
    const pinned = makeFingerprints();
    store.pin('pinned.host', 22, pinned);

    const different = makeDifferentFingerprints();
    mockScanHostKeys.mockResolvedValueOnce(different);

    await expect(verifyHostKey(store, 'pinned.host', 22))
      .rejects
      .toThrow(/Host key mismatch.*pinned\.host/);
  });

  it('mismatch error mentions ssh_host_key_trust', async () => {
    const pinned = makeFingerprints();
    store.pin('bad.host', 22, pinned);

    mockScanHostKeys.mockResolvedValueOnce(makeDifferentFingerprints());

    await expect(verifyHostKey(store, 'bad.host', 22))
      .rejects
      .toThrow(/ssh_host_key_trust/);
  });

  it('fails closed when scan fails and pinned keys exist', async () => {
    store.pin('secure.host', 22, makeFingerprints());
    mockScanHostKeys.mockRejectedValueOnce(new Error('Connection refused'));

    await expect(verifyHostKey(store, 'secure.host', 22))
      .rejects
      .toThrow(/unable to scan live keys/);
  });

  it('skips verification when scan fails and no pinned keys exist', async () => {
    mockScanHostKeys.mockRejectedValueOnce(new Error('ssh-keyscan not found'));

    // Should not throw — no pinned keys, can't scan, skip
    await expect(verifyHostKey(store, 'new.host', 22)).resolves.toBeUndefined();
  });

  it('skips verification when scan returns empty and no pinned keys exist', async () => {
    mockScanHostKeys.mockResolvedValueOnce([]);

    await expect(verifyHostKey(store, 'new.host', 22)).resolves.toBeUndefined();
  });

  it('fails closed when scan returns empty but pinned keys exist', async () => {
    store.pin('existing.host', 22, makeFingerprints());
    mockScanHostKeys.mockResolvedValueOnce([]);

    await expect(verifyHostKey(store, 'existing.host', 22))
      .rejects
      .toThrow(/ssh-keyscan returned no keys/);
  });
});

// Need afterEach import
import { afterEach } from 'vitest';
