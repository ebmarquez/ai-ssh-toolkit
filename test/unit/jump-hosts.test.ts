/**
 * Unit tests for jump_hosts (ProxyJump / -J) support across ssh_execute,
 * ssh_session_open, and ssh_check_host.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';

// ── Shared mocks ─────────────────────────────────────────────────────────────

vi.mock('../../src/ssh/ssh-config-reader.js', () => ({
  resolveSshConfig: vi.fn().mockResolvedValue(null),
}));

// ── node-pty mock (used by pty-manager and ssh-session-open) ─────────────────

let fakeOnData: ((data: string) => void) | null = null;
let fakeOnExit: ((ev: { exitCode: number }) => void) | null = null;
let fakeWrite: MockInstance;
let fakeKill: MockInstance;
let spawnMock: MockInstance;

vi.mock('node-pty', () => {
  fakeWrite = vi.fn();
  fakeKill = vi.fn();
  spawnMock = vi.fn(() => ({
    onData: (cb: (data: string) => void) => {
      fakeOnData = cb;
      return { dispose: vi.fn(() => { fakeOnData = null; }) };
    },
    onExit: (cb: (ev: { exitCode: number }) => void) => {
      fakeOnExit = cb;
      return { dispose: vi.fn(() => { fakeOnExit = null; }) };
    },
    write: fakeWrite,
    kill: fakeKill,
  }));
  return { default: { spawn: spawnMock } };
});

// ── ssh_check_host mocks (cli-resolver + child_process) ──────────────────────

vi.mock('../../src/utils/cli-resolver.js', () => ({
  resolveSshBin: vi.fn().mockResolvedValue('/usr/bin/ssh'),
}));

const execFileMock = vi.fn();
vi.mock('child_process', () => {
  const customSymbol = Symbol.for('nodejs.util.promisify.custom');
  const fn = Object.assign(
    (...args: unknown[]) => execFileMock(...args),
    { [customSymbol]: (...args: unknown[]) => execFileMock(...args) },
  );
  return { execFile: fn };
});

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { runSshSession } = await import('../../src/ssh/pty-manager.js');
import { sshSessionOpen } from '../../src/tools/ssh-session-open.js';
import { sshCheckHost } from '../../src/tools/ssh-check.js';
import { SessionStore } from '../../src/ssh/session-store.js';
import { CredentialMap } from '../../src/credentials/credential-map.js';
import type { CredentialRegistry } from '../../src/credentials/registry.js';

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

beforeEach(() => {
  fakeOnData = null;
  fakeOnExit = null;
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// pty-manager (ssh_execute path)
// ─────────────────────────────────────────────────────────────────────────────

describe('pty-manager jump_hosts', () => {
  it('single jump host adds -J flag', async () => {
    const promise = runSshSession({
      host: 'target.example.com',
      username: 'user',
      command: 'echo hi',
      jump_hosts: ['bastion.example.com'],
      timeout_ms: 5000,
    });
    await new Promise(r => setTimeout(r, 20));
    fakeOnData!('user@target:~$ ');
    fakeOnExit!({ exitCode: 0 });
    await promise;

    const args: string[] = spawnMock.mock.calls[0][1];
    expect(args).toContain('-J');
    expect(args[args.indexOf('-J') + 1]).toBe('bastion.example.com');
  });

  it('chained jump hosts are comma-separated', async () => {
    const promise = runSshSession({
      host: 'target.internal',
      username: 'user',
      command: 'hostname',
      jump_hosts: ['bastion1.example.com', 'bastion2.internal'],
      timeout_ms: 5000,
    });
    await new Promise(r => setTimeout(r, 20));
    fakeOnData!('user@target:~$ ');
    fakeOnExit!({ exitCode: 0 });
    await promise;

    const args: string[] = spawnMock.mock.calls[0][1];
    expect(args).toContain('-J');
    expect(args[args.indexOf('-J') + 1]).toBe('bastion1.example.com,bastion2.internal');
  });

  it('no jump_hosts does not add -J flag (existing behavior)', async () => {
    const promise = runSshSession({
      host: 'target.example.com',
      username: 'user',
      command: 'ls',
      timeout_ms: 5000,
    });
    await new Promise(r => setTimeout(r, 20));
    fakeOnData!('user@target:~$ ');
    fakeOnExit!({ exitCode: 0 });
    await promise;

    const args: string[] = spawnMock.mock.calls[0][1];
    expect(args).not.toContain('-J');
  });

  it('empty jump_hosts array does not add -J flag', async () => {
    const promise = runSshSession({
      host: 'target.example.com',
      username: 'user',
      command: 'ls',
      jump_hosts: [],
      timeout_ms: 5000,
    });
    await new Promise(r => setTimeout(r, 20));
    fakeOnData!('user@target:~$ ');
    fakeOnExit!({ exitCode: 0 });
    await promise;

    const args: string[] = spawnMock.mock.calls[0][1];
    expect(args).not.toContain('-J');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ssh_session_open
// ─────────────────────────────────────────────────────────────────────────────

describe('ssh_session_open jump_hosts', () => {
  it('single jump host adds -J flag', async () => {
    const store = new SessionStore();
    const promise = sshSessionOpen(makeRegistry(), store, {
      host: 'target.example.com',
      username: 'user',
      jump_hosts: ['bastion.example.com'],
      timeout_ms: 5000,
    }, credentialMap);
    await new Promise(r => setTimeout(r, 20));
    fakeOnData!('user@target:~$ ');
    await promise;

    const args: string[] = spawnMock.mock.calls[0][1];
    expect(args).toContain('-J');
    expect(args[args.indexOf('-J') + 1]).toBe('bastion.example.com');
    store.destroy();
  });

  it('chained jump hosts are comma-separated', async () => {
    const store = new SessionStore();
    const promise = sshSessionOpen(makeRegistry(), store, {
      host: 'target.internal',
      username: 'user',
      jump_hosts: ['b1.example.com', 'b2.internal'],
      timeout_ms: 5000,
    }, credentialMap);
    await new Promise(r => setTimeout(r, 20));
    fakeOnData!('user@target:~$ ');
    await promise;

    const args: string[] = spawnMock.mock.calls[0][1];
    expect(args[args.indexOf('-J') + 1]).toBe('b1.example.com,b2.internal');
    store.destroy();
  });

  it('no jump_hosts does not add -J flag', async () => {
    const store = new SessionStore();
    const promise = sshSessionOpen(makeRegistry(), store, {
      host: 'target.example.com',
      username: 'user',
      timeout_ms: 5000,
    }, credentialMap);
    await new Promise(r => setTimeout(r, 20));
    fakeOnData!('user@target:~$ ');
    await promise;

    const args: string[] = spawnMock.mock.calls[0][1];
    expect(args).not.toContain('-J');
    store.destroy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ssh_check_host (auth mode only — tcp/banner don't use ssh binary)
// ─────────────────────────────────────────────────────────────────────────────

describe('ssh_check_host jump_hosts', () => {
  it('auth mode: single jump host adds -J to ssh args', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '', stderr: '' });

    await sshCheckHost(
      { host: 'target.example.com', mode: 'auth', use_ssh_config: false, jump_hosts: ['bastion.example.com'] },
      credentialMap,
    );

    const args: string[] = execFileMock.mock.calls[0][1];
    expect(args).toContain('-J');
    expect(args[args.indexOf('-J') + 1]).toBe('bastion.example.com');
  });

  it('auth mode: chained jump hosts are comma-separated', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '', stderr: '' });

    await sshCheckHost(
      { host: 'target.internal', mode: 'auth', use_ssh_config: false, jump_hosts: ['b1.example.com', 'b2.internal'] },
      credentialMap,
    );

    const args: string[] = execFileMock.mock.calls[0][1];
    expect(args[args.indexOf('-J') + 1]).toBe('b1.example.com,b2.internal');
  });

  it('auth mode: no jump_hosts does not add -J', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '', stderr: '' });

    await sshCheckHost(
      { host: 'target.example.com', mode: 'auth', use_ssh_config: false },
      credentialMap,
    );

    const args: string[] = execFileMock.mock.calls[0][1];
    expect(args).not.toContain('-J');
  });
});
