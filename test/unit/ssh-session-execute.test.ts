/**
 * Unit tests for ssh-session-execute and ssh-session-close (mocks node-pty)
 */

import { describe, it, expect, vi } from 'vitest';
import type { IPty } from 'node-pty';
import type { ManagedSession } from '../../src/ssh/session-store.js';
import { SessionStore } from '../../src/ssh/session-store.js';
import { sshSessionExecute } from '../../src/tools/ssh-session-execute.js';
import { sshSessionClose } from '../../src/tools/ssh-session-close.js';

function makeFakePty(): IPty & { _triggerData: (d: string) => void; _triggerExit: (code: number) => void; write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> } {
  let onDataCb: ((d: string) => void) | null = null;
  let onExitCb: ((ev: { exitCode: number }) => void) | null = null;

  const fakePty = {
    write: vi.fn(),
    kill: vi.fn(),
    onData(cb: (d: string) => void) { onDataCb = cb; },
    onExit(cb: (ev: { exitCode: number }) => void) { onExitCb = cb; },
    _triggerData(d: string) { onDataCb?.(d); },
    _triggerExit(code: number) { onExitCb?.({ exitCode: code }); },
    pid: 1234,
    cols: 220,
    rows: 24,
    process: 'ssh',
    handleFlowControl: false,
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  return fakePty as unknown as typeof fakePty;
}

function makeSession(pty: IPty, overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: crypto.randomUUID(),
    ptyProcess: pty,
    lastActivity: Date.now(),
    host: 'test-host',
    username: 'testuser',
    platform: 'linux',
    outputBuffer: '',
    ...overrides,
  };
}

describe('sshSessionExecute', () => {
  it('writes command to PTY and returns scrubbed output', async () => {
    const store = new SessionStore();
    const pty = makeFakePty();
    const session = makeSession(pty);
    store.add(session);

    const promise = sshSessionExecute(store, {
      session_id: session.id,
      command: 'uname -a',
      timeout_ms: 5000,
    });

    // Simulate PTY emitting command output then prompt
    await new Promise(r => setTimeout(r, 0));
    pty._triggerData('Linux test-host 5.15.0\r\ntestuser@test-host:~$ ');

    const result = await promise;
    expect(result.session_id).toBe(session.id);
    expect(result.output).toContain('Linux test-host');
    expect(result.exit_code).toBeNull();
    expect(pty.write).toHaveBeenCalledWith('uname -a\n');
    store.destroy();
  });

  it('strips ANSI escape codes from output', async () => {
    const store = new SessionStore();
    const pty = makeFakePty();
    const session = makeSession(pty);
    store.add(session);

    const promise = sshSessionExecute(store, {
      session_id: session.id,
      command: 'ls',
      timeout_ms: 5000,
    });

    await new Promise(r => setTimeout(r, 0));
    pty._triggerData('\x1B[32mfile.txt\x1B[0m\r\ntestuser@test-host:~$ ');

    const result = await promise;
    expect(result.output).not.toContain('\x1B[');
    expect(result.output).toContain('file.txt');
    store.destroy();
  });

  it('throws "Session not found or expired" for unknown session_id', async () => {
    const store = new SessionStore();
    await expect(
      sshSessionExecute(store, { session_id: crypto.randomUUID(), command: 'echo hi' })
    ).rejects.toThrow('Session not found or expired');
    store.destroy();
  });

  it('rejects on timeout', async () => {
    const store = new SessionStore();
    const pty = makeFakePty();
    const session = makeSession(pty);
    store.add(session);

    const promise = sshSessionExecute(store, {
      session_id: session.id,
      command: 'sleep 60',
      timeout_ms: 50,
    });

    // Never send a prompt — let it time out
    await expect(promise).rejects.toThrow(/timed out/i);
    store.destroy();
  });

  it('updates lastActivity timestamp', async () => {
    const store = new SessionStore();
    const pty = makeFakePty();
    const oldActivity = Date.now() - 10_000;
    const session = makeSession(pty, { lastActivity: oldActivity });
    store.add(session);

    const promise = sshSessionExecute(store, {
      session_id: session.id,
      command: 'date',
      timeout_ms: 5000,
    });

    await new Promise(r => setTimeout(r, 0));
    pty._triggerData('testuser@test-host:~$ ');

    await promise;
    expect(store.get(session.id)!.lastActivity).toBeGreaterThan(oldActivity);
    store.destroy();
  });
});

describe('sshSessionClose', () => {
  it('writes exit and kills PTY then removes from store', async () => {
    const store = new SessionStore();
    const pty = makeFakePty();
    const session = makeSession(pty);
    store.add(session);

    const result = await sshSessionClose(store, { session_id: session.id });

    expect(result.message).toBe('Session closed');
    expect(pty.write).toHaveBeenCalledWith('exit\n');
    expect(pty.kill).toHaveBeenCalled();
    expect(store.get(session.id)).toBeUndefined();
    store.destroy();
  });

  it('throws "Session not found or expired" for unknown session_id', async () => {
    const store = new SessionStore();
    await expect(
      sshSessionClose(store, { session_id: crypto.randomUUID() })
    ).rejects.toThrow('Session not found or expired');
    store.destroy();
  });
});
