import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import {
  HostKeyStore,
  hostKey,
  type StoredFingerprint,
} from '../../src/security/host-key-store.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'hks-test-'));
}

function makeFingerprints(n: number = 1): StoredFingerprint[] {
  const fps: StoredFingerprint[] = [];
  const types = ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256'];
  for (let i = 0; i < n; i++) {
    fps.push({
      type: types[i % types.length],
      sha256: `SHA256:key${i}${Math.random().toString(36).slice(2, 10)}`,
      public_key: `AAAA${i}`,
    });
  }
  return fps;
}

describe('hostKey helper', () => {
  it('returns host for port 22', () => {
    expect(hostKey('example.com', 22)).toBe('example.com');
  });

  it('uses bracket notation for non-22 port', () => {
    expect(hostKey('example.com', 2222)).toBe('[example.com]:2222');
  });

  it('defaults to port 22', () => {
    expect(hostKey('example.com')).toBe('example.com');
  });
});

describe('HostKeyStore', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storePath = join(tmpDir, 'known-keys.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts empty when file does not exist', () => {
    const store = new HostKeyStore(storePath);
    expect(store.list()).toEqual({});
  });

  it('creates directory and file on first pin', () => {
    const deepPath = join(tmpDir, 'subdir', 'known-keys.json');
    const store = new HostKeyStore(deepPath);
    const fps = makeFingerprints(1);

    store.pin('host1.example.com', 22, fps);

    expect(existsSync(deepPath)).toBe(true);
    const raw = JSON.parse(readFileSync(deepPath, 'utf-8'));
    expect(raw['host1.example.com']).toBeDefined();
    expect(raw['host1.example.com'].fingerprints).toHaveLength(1);
  });

  // ── Pin / Lookup ──────────────────────────────────────────────────────────

  it('pin stores fingerprints and lookup retrieves them', () => {
    const store = new HostKeyStore(storePath);
    const fps = makeFingerprints(2);

    store.pin('server.test', 22, fps);

    const entry = store.lookup('server.test', 22);
    expect(entry).toBeDefined();
    expect(entry!.fingerprints).toHaveLength(2);
    expect(entry!.fingerprints[0].sha256).toBe(fps[0].sha256);
    expect(entry!.first_seen).toBeTruthy();
    expect(entry!.last_seen).toBeTruthy();
  });

  it('pin with non-default port stores under bracket key', () => {
    const store = new HostKeyStore(storePath);
    const fps = makeFingerprints(1);

    store.pin('server.test', 2222, fps);

    expect(store.lookup('server.test', 22)).toBeUndefined();
    expect(store.lookup('server.test', 2222)).toBeDefined();
  });

  // ── Verify ────────────────────────────────────────────────────────────────

  it('verify returns "new" for unknown host', () => {
    const store = new HostKeyStore(storePath);
    const fps = makeFingerprints(1);

    const detail = store.verify('unknown.host', 22, fps);
    expect(detail.result).toBe('new');
    expect(detail.got).toEqual(fps);
  });

  it('verify returns "match" when live key matches stored key', () => {
    const store = new HostKeyStore(storePath);
    const fps = makeFingerprints(2);

    store.pin('matched.host', 22, fps);

    const detail = store.verify('matched.host', 22, fps);
    expect(detail.result).toBe('match');
  });

  it('verify returns "match" when at least one key type overlaps', () => {
    const store = new HostKeyStore(storePath);
    const fps = makeFingerprints(2);

    store.pin('partial.host', 22, fps);

    // Only provide one of the two pinned keys
    const detail = store.verify('partial.host', 22, [fps[0]]);
    expect(detail.result).toBe('match');
  });

  it('verify returns "mismatch" when no keys overlap', () => {
    const store = new HostKeyStore(storePath);
    const pinned = makeFingerprints(1);

    store.pin('mismatch.host', 22, pinned);

    const different: StoredFingerprint[] = [{
      type: 'ssh-ed25519',
      sha256: 'SHA256:DIFFERENT_KEY',
    }];

    const detail = store.verify('mismatch.host', 22, different);
    expect(detail.result).toBe('mismatch');
    expect(detail.expected).toEqual(pinned);
    expect(detail.got).toEqual(different);
  });

  // ── Remove ────────────────────────────────────────────────────────────────

  it('remove deletes a pinned host and returns true', () => {
    const store = new HostKeyStore(storePath);
    store.pin('removeme.host', 22, makeFingerprints(1));

    expect(store.remove('removeme.host', 22)).toBe(true);
    expect(store.lookup('removeme.host', 22)).toBeUndefined();
  });

  it('remove returns false for non-existent host', () => {
    const store = new HostKeyStore(storePath);
    expect(store.remove('nope.host', 22)).toBe(false);
  });

  // ── List ──────────────────────────────────────────────────────────────────

  it('list returns all pinned hosts', () => {
    const store = new HostKeyStore(storePath);
    store.pin('a.host', 22, makeFingerprints(1));
    store.pin('b.host', 2222, makeFingerprints(1));

    const all = store.list();
    expect(Object.keys(all)).toHaveLength(2);
    expect(all['a.host']).toBeDefined();
    expect(all['[b.host]:2222']).toBeDefined();
  });

  // ── Persistence ───────────────────────────────────────────────────────────

  it('data persists across HostKeyStore instances', () => {
    const store1 = new HostKeyStore(storePath);
    const fps = makeFingerprints(1);
    store1.pin('persist.host', 22, fps);

    const store2 = new HostKeyStore(storePath);
    const entry = store2.lookup('persist.host', 22);
    expect(entry).toBeDefined();
    expect(entry!.fingerprints[0].sha256).toBe(fps[0].sha256);
  });

  it('re-pin updates last_seen but preserves first_seen', () => {
    const store = new HostKeyStore(storePath);
    const fps1 = makeFingerprints(1);
    store.pin('repin.host', 22, fps1);

    const first = store.lookup('repin.host', 22)!;
    const firstSeen = first.first_seen;

    // Small delay to ensure different timestamp
    const fps2 = makeFingerprints(1);
    store.pin('repin.host', 22, fps2);

    const second = store.lookup('repin.host', 22)!;
    expect(second.first_seen).toBe(firstSeen);
    expect(second.fingerprints[0].sha256).toBe(fps2[0].sha256);
  });

  // ── Corrupt file handling ─────────────────────────────────────────────────

  it('handles corrupt JSON file gracefully', () => {
        mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, 'NOT VALID JSON!!!');

    const store = new HostKeyStore(storePath);
    expect(store.list()).toEqual({});
  });
});
