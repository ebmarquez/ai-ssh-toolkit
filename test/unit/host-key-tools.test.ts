import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { HostKeyStore, type StoredFingerprint } from '../../src/security/host-key-store.js';
import { sshHostKeyTrust } from '../../src/tools/ssh-host-key-trust.js';
import { sshHostKeyList } from '../../src/tools/ssh-host-key-list.js';
import { sshHostKeyRemove } from '../../src/tools/ssh-host-key-remove.js';

// Mock SSH config and scanner
vi.mock('../../src/ssh/ssh-config-reader.js', () => ({
  resolveSshConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/security/host-key-scanner.js', () => ({
  scanHostKeys: vi.fn(),
}));

import { scanHostKeys } from '../../src/security/host-key-scanner.js';
const mockScanHostKeys = vi.mocked(scanHostKeys);

function makeFingerprints(): StoredFingerprint[] {
  return [
    { type: 'ssh-ed25519', sha256: 'SHA256:testkey', public_key: 'AAAA1' },
  ];
}

describe('ssh_host_key_trust', () => {
  let tmpDir: string;
  let store: HostKeyStore;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), 'trust-test-'));
    store = new HostKeyStore(join(tmpDir, 'known-keys.json'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pins live-fetched keys when fingerprint is omitted', async () => {
    const fps = makeFingerprints();
    mockScanHostKeys.mockResolvedValueOnce(fps);

    const result = await sshHostKeyTrust(store, { host: 'trust.host', use_ssh_config: false });

    expect(result.pinned).toHaveLength(1);
    expect(result.pinned[0].sha256).toBe('SHA256:testkey');
    expect(store.lookup('trust.host', 22)).toBeDefined();
  });

  it('pins explicit fingerprint when provided', async () => {
    const result = await sshHostKeyTrust(store, {
      host: 'explicit.host',
      fingerprint: 'SHA256:manualpinned',
      key_type: 'ssh-rsa',
      use_ssh_config: false,
    });

    expect(result.pinned[0].sha256).toBe('SHA256:manualpinned');
    expect(result.pinned[0].type).toBe('ssh-rsa');
  });

  it('normalizes fingerprint without SHA256: prefix', async () => {
    const result = await sshHostKeyTrust(store, {
      host: 'norm.host',
      fingerprint: 'barebase64value',
      use_ssh_config: false,
    });

    expect(result.pinned[0].sha256).toBe('SHA256:barebase64value');
  });

  it('re-pins overwrites previous fingerprint', async () => {
    const fps1 = makeFingerprints();
    mockScanHostKeys.mockResolvedValueOnce(fps1);
    await sshHostKeyTrust(store, { host: 'repin.host', use_ssh_config: false });

    const fps2: StoredFingerprint[] = [
      { type: 'ssh-rsa', sha256: 'SHA256:newkey', public_key: 'BBBB' },
    ];
    mockScanHostKeys.mockResolvedValueOnce(fps2);
    await sshHostKeyTrust(store, { host: 'repin.host', use_ssh_config: false });

    const entry = store.lookup('repin.host', 22);
    expect(entry!.fingerprints[0].sha256).toBe('SHA256:newkey');
  });

  it('throws when no keys are retrieved and fingerprint not provided', async () => {
    mockScanHostKeys.mockResolvedValueOnce([]);

    await expect(
      sshHostKeyTrust(store, { host: 'empty.host', use_ssh_config: false }),
    ).rejects.toThrow(/No host keys retrieved/);
  });
});

describe('ssh_host_key_list', () => {
  let tmpDir: string;
  let store: HostKeyStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'list-test-'));
    store = new HostKeyStore(join(tmpDir, 'known-keys.json'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty hosts when no keys are pinned', () => {
    const result = sshHostKeyList(store);
    expect(result.hosts).toEqual({});
    expect(result.store_path).toContain('known-keys.json');
  });

  it('returns all pinned hosts', () => {
    store.pin('a.host', 22, makeFingerprints());
    store.pin('b.host', 2222, makeFingerprints());

    const result = sshHostKeyList(store);
    expect(Object.keys(result.hosts)).toHaveLength(2);
  });
});

describe('ssh_host_key_remove', () => {
  let tmpDir: string;
  let store: HostKeyStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'remove-test-'));
    store = new HostKeyStore(join(tmpDir, 'known-keys.json'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes a pinned host', () => {
    store.pin('removeme.host', 22, makeFingerprints());
    const result = sshHostKeyRemove(store, { host: 'removeme.host' });

    expect(result.removed).toBe(true);
    expect(store.lookup('removeme.host', 22)).toBeUndefined();
  });

  it('returns removed=false for non-existent host', () => {
    const result = sshHostKeyRemove(store, { host: 'nope.host' });
    expect(result.removed).toBe(false);
  });

  it('removes host on specific port', () => {
    store.pin('porthost', 2222, makeFingerprints());

    const result = sshHostKeyRemove(store, { host: 'porthost', port: 2222 });
    expect(result.removed).toBe(true);
  });
});
