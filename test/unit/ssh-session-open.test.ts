/**
 * Unit tests for ssh-session-open (mocks node-pty)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';

// ---- node-pty mock -------------------------------------------------------
interface FakePtyHandlers {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (ev: { exitCode: number }) => void) => void;
  write: MockInstance;
  kill: MockInstance;
}

let fakeOnData: ((data: string) => void) | null = null;
let fakeOnExit: ((ev: { exitCode: number }) => void) | null = null;
let fakeWrite: MockInstance;
let fakeKill: MockInstance;
let spawnMock: MockInstance;

vi.mock('node-pty', () => {
  fakeWrite = vi.fn();
  fakeKill = vi.fn();
  spawnMock = vi.fn((): FakePtyHandlers => ({
    onData: (cb) => { fakeOnData = cb; },
    onExit: (cb) => { fakeOnExit = cb; },
    write: fakeWrite,
    kill: fakeKill,
  }));
  return { default: { spawn: spawnMock } };
});
// -------------------------------------------------------------------------

import { SessionStore } from '../../src/ssh/session-store.js';
import { sshSessionOpen } from '../../src/tools/ssh-session-open.js';
import type { CredentialRegistry } from '../../src/credentials/registry.js';

function makeRegistry(overrides: Partial<CredentialRegistry> = {}): CredentialRegistry {
  return {
    getBackend: vi.fn().mockReturnValue({
      isAvailable: vi.fn().mockResolvedValue(true),
      getCredential: vi.fn().mockResolvedValue({
        username: 'testuser',
        password: Buffer.from('testpass'),
      }),
      cleanup: vi.fn().mockResolvedValue(undefined),
    }),
    register: vi.fn(),
    ...overrides,
  } as unknown as CredentialRegistry;
}

beforeEach(() => {
  fakeOnData = null;
  fakeOnExit = null;
  vi.clearAllMocks();
});

describe('sshSessionOpen', () => {
  it('returns a session_id and adds session to store on successful connect', async () => {
    const store = new SessionStore();
    const registry = makeRegistry();

    const promise = sshSessionOpen(registry, store, {
      host: 'test-host',
      username: 'eric',
      platform: 'linux',
      timeout_ms: 5000,
    });

    // Let dynamic import resolve
    await new Promise(r => setTimeout(r, 0));

    // Simulate shell prompt appearing
    fakeOnData!('eric@test-host:~$ ');

    const result = await promise;
    expect(result.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(result.host).toBe('test-host');
    expect(result.username).toBe('eric');
    expect(result.message).toBe('Session opened successfully');

    // Session should be in the store
    expect(store.get(result.session_id)).toBeDefined();
    store.destroy();
  });

  it('sends password when prompted and resolves on shell prompt', async () => {
    const store = new SessionStore();
    const registry = makeRegistry();

    const promise = sshSessionOpen(registry, store, {
      host: 'test-host',
      credential_ref: 'my-cred',
      credential_backend: 'bitwarden',
      platform: 'linux',
      timeout_ms: 5000,
    });

    await new Promise(r => setTimeout(r, 0));

    // Simulate password prompt, then shell prompt
    fakeOnData!('Password: ');
    await new Promise(r => setTimeout(r, 10));
    fakeOnData!('eric@test-host:~$ ');

    const result = await promise;
    expect(result.session_id).toBeDefined();
    expect(fakeWrite).toHaveBeenCalledWith(expect.stringContaining('testpass'));
    store.destroy();
  });

  it('rejects on timeout', async () => {
    const store = new SessionStore();
    const registry = makeRegistry();

    const promise = sshSessionOpen(registry, store, {
      host: 'test-host',
      username: 'eric',
      platform: 'linux',
      timeout_ms: 50,
    });

    // Never send a prompt — let it time out
    await expect(promise).rejects.toThrow(/timed out/i);
    expect(fakeKill).toHaveBeenCalled();
    store.destroy();
  });

  it('rejects with error when PTY exits before prompt', async () => {
    const store = new SessionStore();
    const registry = makeRegistry();

    const promise = sshSessionOpen(registry, store, {
      host: 'test-host',
      username: 'eric',
      platform: 'linux',
      timeout_ms: 5000,
    });

    await new Promise(r => setTimeout(r, 0));

    // PTY exits before we see a prompt
    fakeOnExit!({ exitCode: 255 });

    await expect(promise).rejects.toThrow(/exited unexpectedly/i);
    store.destroy();
  });
});
