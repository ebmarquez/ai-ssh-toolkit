/**
 * Unit tests for session-reuse.ts and the reuse integration in ssh-execute.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

// ── SessionReuseManager unit tests ──────────────────────────────────────────

describe('SessionReuseManager', () => {
  // Import directly (no mocking needed for unit tests)
  let SessionReuseManager: typeof import('../../src/ssh/session-reuse.js').SessionReuseManager;
  let getSessionReuseTtl: typeof import('../../src/ssh/session-reuse.js').getSessionReuseTtl;

  beforeEach(async () => {
    const mod = await import('../../src/ssh/session-reuse.js');
    SessionReuseManager = mod.SessionReuseManager;
    getSessionReuseTtl = mod.getSessionReuseTtl;
  });

  it('isEnabled returns true when TTL > 0', () => {
    const mgr = new SessionReuseManager(60);
    expect(mgr.isEnabled()).toBe(true);
  });

  it('isEnabled returns false when TTL is 0', () => {
    const mgr = new SessionReuseManager(0);
    expect(mgr.isEnabled()).toBe(false);
  });

  it('shouldReuse returns false when no activity recorded', () => {
    const mgr = new SessionReuseManager(60);
    expect(mgr.shouldReuse('host1', 'user1')).toBe(false);
  });

  it('shouldReuse returns true within TTL after recordActivity', () => {
    const mgr = new SessionReuseManager(60);
    mgr.recordActivity('host1', 'user1');
    expect(mgr.shouldReuse('host1', 'user1')).toBe(true);
  });

  it('shouldReuse returns false for different host', () => {
    const mgr = new SessionReuseManager(60);
    mgr.recordActivity('host1', 'user1');
    expect(mgr.shouldReuse('host2', 'user1')).toBe(false);
  });

  it('shouldReuse returns false for different user', () => {
    const mgr = new SessionReuseManager(60);
    mgr.recordActivity('host1', 'user1');
    expect(mgr.shouldReuse('host1', 'user2')).toBe(false);
  });

  it('shouldReuse returns false after TTL expires', () => {
    const mgr = new SessionReuseManager(1); // 1 second TTL
    // Record activity 2 seconds in the past
    mgr.recordActivity('host1', 'user1');
    // Manually expire by manipulating the internal map
    const key = 'user1@host1';
    (mgr as unknown as { activity: Map<string, number> }).activity.set(
      key,
      Date.now() - 2000,
    );
    expect(mgr.shouldReuse('host1', 'user1')).toBe(false);
  });

  it('shouldReuse returns false when disabled (TTL=0)', () => {
    const mgr = new SessionReuseManager(0);
    mgr.recordActivity('host1', 'user1');
    expect(mgr.shouldReuse('host1', 'user1')).toBe(false);
  });

  it('getControlMasterArgs returns correct SSH options', () => {
    const mgr = new SessionReuseManager(60);
    const args = mgr.getControlMasterArgs();
    expect(args).toContain('-o');
    expect(args).toContain('ControlMaster=auto');
    // ControlPath should reference the tmpdir-based path with SSH tokens
    const controlPathArg = args.find(a => a.startsWith('ControlPath='));
    expect(controlPathArg).toBeDefined();
    expect(controlPathArg).toContain('ai-ssh-toolkit');
    expect(controlPathArg).toContain('cm-%h-%p-%r');
    // ControlPersist should match the TTL
    expect(args).toContain('ControlPersist=60');
  });

  it('getControlMasterArgs returns empty array when disabled', () => {
    const mgr = new SessionReuseManager(0);
    expect(mgr.getControlMasterArgs()).toEqual([]);
  });

  it('clear removes all tracked activity', () => {
    const mgr = new SessionReuseManager(60);
    mgr.recordActivity('host1', 'user1');
    expect(mgr.shouldReuse('host1', 'user1')).toBe(true);
    mgr.clear();
    expect(mgr.shouldReuse('host1', 'user1')).toBe(false);
  });

  describe('getSessionReuseTtl', () => {
    const origEnv = process.env.AI_SSH_SESSION_REUSE_TTL_SECONDS;

    afterEach(() => {
      if (origEnv === undefined) {
        delete process.env.AI_SSH_SESSION_REUSE_TTL_SECONDS;
      } else {
        process.env.AI_SSH_SESSION_REUSE_TTL_SECONDS = origEnv;
      }
    });

    it('returns 60 by default', () => {
      delete process.env.AI_SSH_SESSION_REUSE_TTL_SECONDS;
      expect(getSessionReuseTtl()).toBe(60);
    });

    it('reads from env var', () => {
      process.env.AI_SSH_SESSION_REUSE_TTL_SECONDS = '120';
      expect(getSessionReuseTtl()).toBe(120);
    });

    it('returns 0 to disable', () => {
      process.env.AI_SSH_SESSION_REUSE_TTL_SECONDS = '0';
      expect(getSessionReuseTtl()).toBe(0);
    });

    it('ignores invalid env values and returns default', () => {
      process.env.AI_SSH_SESSION_REUSE_TTL_SECONDS = 'abc';
      expect(getSessionReuseTtl()).toBe(60);
    });
  });
});

// ── ssh_execute integration with session reuse ──────────────────────────────

// ---- ssh-config-reader mock ------------------------------------------------
vi.mock('../../src/ssh/ssh-config-reader.js', () => ({
  resolveSshConfig: vi.fn().mockResolvedValue(null),
}));

// ---- node-pty mock ---------------------------------------------------------
let fakeOnData: ((data: string) => void) | null = null;
let fakeOnExit: ((ev: { exitCode: number }) => void) | null = null;
let fakeWrite: MockInstance;
let fakeKill: MockInstance;
let spawnMock: MockInstance;

vi.mock('node-pty', () => {
  fakeWrite = vi.fn();
  fakeKill = vi.fn();
  spawnMock = vi.fn(() => ({
    onData: (cb: (data: string) => void) => { fakeOnData = cb; },
    onExit: (cb: (ev: { exitCode: number }) => void) => { fakeOnExit = cb; },
    write: fakeWrite,
    kill: fakeKill,
  }));
  return { default: { spawn: spawnMock } };
});

// Import after mocks
const { sshExecute } = await import('../../src/tools/ssh-execute.js');
const { SessionReuseManager: SRM } = await import('../../src/ssh/session-reuse.js');
import type { CredentialRegistry } from '../../src/credentials/registry.js';
import { CredentialMap } from '../../src/credentials/credential-map.js';

function makeRegistry(): CredentialRegistry {
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
  } as unknown as CredentialRegistry;
}

const credentialMap = new CredentialMap('/dev/null/nonexistent');

describe('sshExecute with session reuse', () => {
  beforeEach(() => {
    fakeOnData = null;
    fakeOnExit = null;
    vi.clearAllMocks();
  });

  it('includes ControlMaster args when reuse is enabled', async () => {
    const mgr = new SRM(60);
    const registry = makeRegistry();

    const promise = sshExecute(registry, {
      host: 'test-host',
      command: 'echo hello',
      username: 'testuser',
      platform: 'linux',
      timeout_ms: 5000,
    }, credentialMap, undefined, mgr);

    await new Promise(r => setTimeout(r, 20));
    fakeOnData!('testuser@test-host:~$ ');
    fakeOnExit!({ exitCode: 0 });

    await promise;

    // Verify ControlMaster args were passed to ssh spawn
    const sshArgs: string[] = spawnMock.mock.calls[0][1];
    expect(sshArgs).toContain('ControlMaster=auto');
    expect(sshArgs.some((a: string) => a.startsWith('ControlPath='))).toBe(true);
    expect(sshArgs).toContain('ControlPersist=60');
  });

  it('records activity after successful execution', async () => {
    const mgr = new SRM(60);
    const registry = makeRegistry();

    expect(mgr.shouldReuse('test-host', 'testuser')).toBe(false);

    const promise = sshExecute(registry, {
      host: 'test-host',
      command: 'echo hello',
      username: 'testuser',
      platform: 'linux',
      timeout_ms: 5000,
    }, credentialMap, undefined, mgr);

    await new Promise(r => setTimeout(r, 20));
    fakeOnData!('testuser@test-host:~$ ');
    fakeOnExit!({ exitCode: 0 });

    await promise;

    // After successful execution, activity should be recorded
    expect(mgr.shouldReuse('test-host', 'testuser')).toBe(true);
  });

  it('does not include ControlMaster args when reuse_session is false', async () => {
    const mgr = new SRM(60);
    const registry = makeRegistry();

    const promise = sshExecute(registry, {
      host: 'test-host',
      command: 'echo hello',
      username: 'testuser',
      platform: 'linux',
      timeout_ms: 5000,
      reuse_session: false,
    }, credentialMap, undefined, mgr);

    await new Promise(r => setTimeout(r, 20));
    fakeOnData!('testuser@test-host:~$ ');
    fakeOnExit!({ exitCode: 0 });

    await promise;

    const sshArgs: string[] = spawnMock.mock.calls[0][1];
    expect(sshArgs).not.toContain('ControlMaster=auto');
  });

  it('includes ControlMaster args when reuse_session is explicitly true', async () => {
    const mgr = new SRM(60);
    const registry = makeRegistry();

    const promise = sshExecute(registry, {
      host: 'test-host',
      command: 'echo hello',
      username: 'testuser',
      platform: 'linux',
      timeout_ms: 5000,
      reuse_session: true,
    }, credentialMap, undefined, mgr);

    await new Promise(r => setTimeout(r, 20));
    fakeOnData!('testuser@test-host:~$ ');
    fakeOnExit!({ exitCode: 0 });

    await promise;

    const sshArgs: string[] = spawnMock.mock.calls[0][1];
    expect(sshArgs).toContain('ControlMaster=auto');
  });

  it('does not include ControlMaster args when no reuseManager is provided', async () => {
    const registry = makeRegistry();

    const promise = sshExecute(registry, {
      host: 'test-host',
      command: 'echo hello',
      username: 'testuser',
      platform: 'linux',
      timeout_ms: 5000,
    }, credentialMap);

    await new Promise(r => setTimeout(r, 20));
    fakeOnData!('testuser@test-host:~$ ');
    fakeOnExit!({ exitCode: 0 });

    await promise;

    const sshArgs: string[] = spawnMock.mock.calls[0][1];
    expect(sshArgs).not.toContain('ControlMaster=auto');
  });

  it('does not include ControlMaster args when TTL is 0 (disabled)', async () => {
    const mgr = new SRM(0);
    const registry = makeRegistry();

    const promise = sshExecute(registry, {
      host: 'test-host',
      command: 'echo hello',
      username: 'testuser',
      platform: 'linux',
      timeout_ms: 5000,
    }, credentialMap, undefined, mgr);

    await new Promise(r => setTimeout(r, 20));
    fakeOnData!('testuser@test-host:~$ ');
    fakeOnExit!({ exitCode: 0 });

    await promise;

    const sshArgs: string[] = spawnMock.mock.calls[0][1];
    expect(sshArgs).not.toContain('ControlMaster=auto');
  });

  it('returns same shape as regular ssh_execute (transparent reuse)', async () => {
    const mgr = new SRM(60);
    const registry = makeRegistry();

    const promise = sshExecute(registry, {
      host: 'test-host',
      command: 'echo hello',
      username: 'testuser',
      platform: 'linux',
      timeout_ms: 5000,
    }, credentialMap, undefined, mgr);

    await new Promise(r => setTimeout(r, 20));
    fakeOnData!('hello\r\ntestuser@test-host:~$ ');
    fakeOnExit!({ exitCode: 0 });

    const result = await promise;
    expect(result).toHaveProperty('output');
    expect(result).toHaveProperty('exit_code');
    expect(result.exit_code).toBe(0);
    expect(typeof result.output).toBe('string');
  });
});
