/**
 * Unit tests for pty-manager.ts
 * Mocks node-pty to avoid real SSH connections.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { PtySessionOptions } from '../../src/ssh/pty-manager.js';

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

// Import AFTER mock is set up
const { runSshSession } = await import('../../src/ssh/pty-manager.js');

function makeOpts(overrides: Partial<PtySessionOptions> = {}): PtySessionOptions {
  return {
    host: 'test-host',
    username: 'testuser',
    password: Buffer.from('secret'),
    command: 'echo hello',
    platform: 'linux',
    timeout_ms: 5000,
    ...overrides,
  };
}

beforeEach(() => {
  fakeOnData = null;
  fakeOnExit = null;
  vi.clearAllMocks();
});

describe('runSshSession', () => {
  it('returns output and exit_code on successful command', async () => {
    const promise = runSshSession(makeOpts());

    // Let the dynamic import inside runSshSession resolve before interacting
    await new Promise(r => setTimeout(r, 0));

    // Simulate command output then exit
    fakeOnData!('eric@test-host:~$ ');
    fakeOnExit!({ exitCode: 0 });

    const result = await promise;
    expect(result.exit_code).toBe(0);
    expect(typeof result.output).toBe('string');
    // Verify rows:0 is passed to prevent --More-- pagination on network devices
    expect(spawnMock).toHaveBeenCalledWith(
      'ssh',
      expect.any(Array),
      expect.objectContaining({ rows: 0 }),
    );
  });

  it('handles password prompt and sends password', async () => {
    const promise = runSshSession(makeOpts({ password: Buffer.from('mypassword') }));

    // Let the dynamic import inside runSshSession resolve before interacting
    await new Promise(r => setTimeout(r, 0));

    // Simulate password prompt then shell prompt then exit
    fakeOnData!('Password: ');
    // Give the event loop a tick to process
    await new Promise(r => setTimeout(r, 10));
    fakeOnData!('eric@test-host:~$ ');
    fakeOnExit!({ exitCode: 0 });

    const result = await promise;
    expect(result.exit_code).toBe(0);
    // Verify password was sent
    expect(fakeWrite).toHaveBeenCalledWith(expect.stringContaining('mypassword'));
  });

  it('rejects on timeout', async () => {
    const promise = runSshSession(makeOpts({ timeout_ms: 50 }));

    // Never send exit — let it time out
    await expect(promise).rejects.toThrow(/timed out/i);
    expect(fakeKill).toHaveBeenCalled();
  });

  it('cleans up PTY on error (timeout path)', async () => {
    const promise = runSshSession(makeOpts({ timeout_ms: 50 }));
    await expect(promise).rejects.toThrow();
    expect(fakeKill).toHaveBeenCalledTimes(1);
  });

  it('scrubs ANSI escape sequences from output', async () => {
    const promise = runSshSession(makeOpts());

    // Let the dynamic import inside runSshSession resolve before interacting
    await new Promise(r => setTimeout(r, 0));

    // Simulate output with ANSI codes
    fakeOnData!('\x1B[32mhello\x1B[0m\r\neric@test-host:~$ ');
    fakeOnExit!({ exitCode: 0 });

    const result = await promise;
    expect(result.output).not.toContain('\x1B[');
    expect(result.output).toContain('hello');
  });
});
