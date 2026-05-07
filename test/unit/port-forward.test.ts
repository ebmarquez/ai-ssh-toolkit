import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------
const spawnMock = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: vi.fn(),
}));

// Mock resolveSshBin
vi.mock('../../src/utils/cli-resolver.js', () => ({
  resolveSshBin: vi.fn().mockResolvedValue('/usr/bin/ssh'),
  resolveCliPath: vi.fn().mockReturnValue('/usr/bin/ssh'),
}));

// Mock resolveSshConfig
vi.mock('../../src/ssh/ssh-config-reader.js', () => ({
  resolveSshConfig: vi.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a fake ChildProcess that stays alive (doesn't auto-close). */
function makeFakeChild(): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const stderr = new EventEmitter();
  Object.assign(child, {
    pid: 12345,
    killed: false,
    stdin: null,
    stdout: null,
    stderr,
    stdio: [null, null, stderr],
    exitCode: null,
    signalCode: null,
    connected: false,
    channel: undefined,
    send: vi.fn(),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn(),
    [Symbol.dispose]: vi.fn(),
    kill: vi.fn(function (this: { killed: boolean }) {
      this.killed = true;
      return true;
    }),
  });
  return child;
}

/** Creates a fake child that exits immediately with given code. */
function makeFakeChildExiting(code: number, stderrMsg?: string): ChildProcess & EventEmitter {
  const child = makeFakeChild();
  // Schedule exit on next tick so spawn can return first
  setImmediate(() => {
    if (stderrMsg && child.stderr) {
      child.stderr.emit('data', Buffer.from(stderrMsg));
    }
    child.emit('close', code);
  });
  return child;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SSH port forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    // Clean up any active forwards
    const { destroyAllForwards } = await import('../../src/ssh/forward-manager.js');
    destroyAllForwards();
    vi.useRealTimers();
  });

  // ── Local forward (-L) ─────────────────────────────────────────────────

  describe('ssh_forward_local', () => {
    it('spawns ssh with correct -L args', async () => {
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const { startLocalForward } = await import('../../src/ssh/forward-manager.js');
      const resultP = startLocalForward({
        host: 'bastion.example.com',
        local_port: 8080,
        remote_host: 'db.internal',
        remote_port: 5432,
        username: 'admin',
      });

      // Let the 500ms stabilization timer pass
      await vi.advanceTimersByTimeAsync(600);
      const result = await resultP;

      expect(result.status).toBe('active');
      expect(result.local_port).toBe(8080);
      expect(result.remote_host).toBe('db.internal');
      expect(result.remote_port).toBe(5432);
      expect(result.forward_id).toBeTruthy();

      // Verify spawn args
      const [bin, args] = spawnMock.mock.calls[0];
      expect(bin).toBe('/usr/bin/ssh');
      expect(args).toContain('-N');
      expect(args).toContain('-L');
      expect(args).toContain('8080:db.internal:5432');
      expect(args).toContain('-l');
      expect(args).toContain('admin');
      expect(args).toContain('--');
      expect(args).toContain('bastion.example.com');
      expect(args).toContain('BatchMode=yes');
      expect(args).toContain('ExitOnForwardFailure=yes');
    });

    it('fails when ssh exits immediately', async () => {
      const child = makeFakeChildExiting(255, 'Connection refused');
      spawnMock.mockReturnValue(child);

      const { startLocalForward } = await import('../../src/ssh/forward-manager.js');

      await expect(
        startLocalForward({
          host: 'bad.example.com',
          local_port: 8080,
          remote_host: 'db.internal',
          remote_port: 5432,
        })
      ).rejects.toThrow(/Forward failed/);
    });
  });

  // ── Remote forward (-R) ────────────────────────────────────────────────

  describe('ssh_forward_remote', () => {
    it('spawns ssh with correct -R args', async () => {
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const { startRemoteForward } = await import('../../src/ssh/forward-manager.js');
      const resultP = startRemoteForward({
        host: 'gateway.example.com',
        remote_port: 9090,
        local_host: 'localhost',
        local_port: 3000,
        username: 'deploy',
      });

      await vi.advanceTimersByTimeAsync(600);
      const result = await resultP;

      expect(result.status).toBe('active');
      expect(result.local_port).toBe(3000);
      expect(result.remote_port).toBe(9090);

      const [, args] = spawnMock.mock.calls[0];
      expect(args).toContain('-R');
      expect(args).toContain('9090:localhost:3000');
      expect(args).toContain('-l');
      expect(args).toContain('deploy');
      expect(args).toContain('gateway.example.com');
    });
  });

  // ── Dynamic forward (-D) ──────────────────────────────────────────────

  describe('ssh_forward_dynamic', () => {
    it('spawns ssh with correct -D args', async () => {
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const { startDynamicForward } = await import('../../src/ssh/forward-manager.js');
      const resultP = startDynamicForward({
        host: 'proxy.example.com',
        local_port: 1080,
        username: 'socksuser',
      });

      await vi.advanceTimersByTimeAsync(600);
      const result = await resultP;

      expect(result.status).toBe('active');
      expect(result.local_port).toBe(1080);
      expect(result.remote_host).toBeUndefined();
      expect(result.remote_port).toBeUndefined();

      const [, args] = spawnMock.mock.calls[0];
      expect(args).toContain('-D');
      expect(args).toContain('1080');
      expect(args).toContain('proxy.example.com');
    });
  });

  // ── List ───────────────────────────────────────────────────────────────

  describe('ssh_forward_list', () => {
    it('returns all active forwards', async () => {
      const child1 = makeFakeChild();
      const child2 = makeFakeChild();
      spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

      const { startLocalForward, startDynamicForward, listForwards } = await import(
        '../../src/ssh/forward-manager.js'
      );

      const p1 = startLocalForward({
        host: 'host1.example.com',
        local_port: 8080,
        remote_host: 'db.internal',
        remote_port: 5432,
      });
      await vi.advanceTimersByTimeAsync(600);
      await p1;

      const p2 = startDynamicForward({
        host: 'host2.example.com',
        local_port: 1080,
      });
      await vi.advanceTimersByTimeAsync(600);
      await p2;

      const list = listForwards();
      expect(list).toHaveLength(2);
      expect(list[0].type).toBe('local');
      expect(list[1].type).toBe('dynamic');
      expect(list.every((e) => e.status === 'active')).toBe(true);
    });

    it('returns empty array when no forwards', async () => {
      const { listForwards } = await import('../../src/ssh/forward-manager.js');
      expect(listForwards()).toEqual([]);
    });
  });

  // ── Close ──────────────────────────────────────────────────────────────

  describe('ssh_forward_close', () => {
    it('kills process and removes entry', async () => {
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const { startLocalForward, closeForward, listForwards } = await import(
        '../../src/ssh/forward-manager.js'
      );

      const resultP = startLocalForward({
        host: 'host.example.com',
        local_port: 8080,
        remote_host: 'db.internal',
        remote_port: 5432,
      });
      await vi.advanceTimersByTimeAsync(600);
      const result = await resultP;

      expect(listForwards()).toHaveLength(1);

      const closeResult = closeForward(result.forward_id);
      expect(closeResult.status).toBe('closed');
      expect(child.kill).toHaveBeenCalled();
      expect(listForwards()).toHaveLength(0);
    });

    it('throws for unknown forward_id', async () => {
      const { closeForward } = await import('../../src/ssh/forward-manager.js');
      expect(() => closeForward('nonexistent-id')).toThrow(/No active forward/);
    });

    it('is idempotent via destroyAllForwards', async () => {
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const { startLocalForward, destroyAllForwards, listForwards } = await import(
        '../../src/ssh/forward-manager.js'
      );

      const resultP = startLocalForward({
        host: 'host.example.com',
        local_port: 8080,
        remote_host: 'db.internal',
        remote_port: 5432,
      });
      await vi.advanceTimersByTimeAsync(600);
      await resultP;

      destroyAllForwards();
      expect(listForwards()).toHaveLength(0);

      // Second call should not throw
      destroyAllForwards();
      expect(listForwards()).toHaveLength(0);
    });
  });

  // ── Timeout ────────────────────────────────────────────────────────────

  describe('idle timeout', () => {
    it('auto-closes forward after timeout', async () => {
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const { startLocalForward, listForwards } = await import('../../src/ssh/forward-manager.js');

      const resultP = startLocalForward({
        host: 'host.example.com',
        local_port: 8080,
        remote_host: 'db.internal',
        remote_port: 5432,
        idle_timeout_seconds: 10,
      });
      await vi.advanceTimersByTimeAsync(600);
      await resultP;

      expect(listForwards()).toHaveLength(1);

      // Advance past the timeout
      await vi.advanceTimersByTimeAsync(10_000);

      expect(listForwards()).toHaveLength(0);
      expect(child.kill).toHaveBeenCalled();
    });
  });

  // ── Process exit auto-cleanup ──────────────────────────────────────────

  describe('process exit cleanup', () => {
    it('removes entry when ssh process exits', async () => {
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const { startLocalForward, listForwards } = await import('../../src/ssh/forward-manager.js');

      const resultP = startLocalForward({
        host: 'host.example.com',
        local_port: 8080,
        remote_host: 'db.internal',
        remote_port: 5432,
      });
      await vi.advanceTimersByTimeAsync(600);
      await resultP;

      expect(listForwards()).toHaveLength(1);

      // Simulate process exit
      child.emit('close', 0);

      expect(listForwards()).toHaveLength(0);
    });
  });

  // ── use_ssh_config=false ───────────────────────────────────────────────

  describe('ssh config', () => {
    it('passes -F /dev/null when use_ssh_config=false', async () => {
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);

      const { startLocalForward } = await import('../../src/ssh/forward-manager.js');

      const resultP = startLocalForward({
        host: 'host.example.com',
        local_port: 8080,
        remote_host: 'db.internal',
        remote_port: 5432,
        use_ssh_config: false,
      });
      await vi.advanceTimersByTimeAsync(600);
      await resultP;

      const [, args] = spawnMock.mock.calls[0];
      expect(args).toContain('-F');
      expect(args).toContain('/dev/null');
    });
  });
});
