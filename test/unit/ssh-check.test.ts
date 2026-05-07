import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type * as net from 'net';
import { sshCheckHost, tcpBannerProbe } from '../../src/tools/ssh-check.js';
import { CredentialMap } from '../../src/credentials/credential-map.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Fake net.Socket built on EventEmitter with the methods tcpBannerProbe uses. */
class FakeSocket extends EventEmitter {
  destroyed = false;
  connect = vi.fn((_port: number, _host: string, cb?: () => void) => {
    // default: connect succeeds immediately
    if (cb) setImmediate(cb);
    return this;
  });
  setTimeout = vi.fn();
  destroy = vi.fn(() => { this.destroyed = true; });
  removeAllListeners = vi.fn(() => this);
}

function makeCredentialMap(): CredentialMap {
  // Construct with a non-existent path so no real file is loaded
  return new CredentialMap('/dev/null/no-such-credential-map.json');
}

// Mock resolveSshConfig so it never touches the real filesystem
vi.mock('../../src/ssh/ssh-config-reader.js', () => ({
  resolveSshConfig: vi.fn().mockResolvedValue(null),
}));

// Mock resolveSshBin / execFile for auth mode tests
vi.mock('../../src/utils/cli-resolver.js', () => ({
  resolveSshBin: vi.fn().mockResolvedValue('/usr/bin/ssh'),
}));

const execFileMock = vi.fn();
vi.mock('child_process', () => {
  // Use the well-known promisify custom symbol so that
  // promisify(execFile) delegates directly to execFileMock (returns Promises).
  const customSymbol = Symbol.for('nodejs.util.promisify.custom');
  const fn = Object.assign(
    (...args: unknown[]) => execFileMock(...args),
    { [customSymbol]: (...args: unknown[]) => execFileMock(...args) },
  );
  return { execFile: fn };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ssh_check_host', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── tcpBannerProbe direct tests ────────────────────────────────────────

  describe('tcpBannerProbe', () => {
    it('mode=banner: returns SSH banner when server sends one', async () => {
      const sock = new FakeSocket();
      sock.connect = vi.fn((_p: number, _h: string, cb?: () => void) => {
        setImmediate(() => {
          cb?.();
          setImmediate(() => sock.emit('data', Buffer.from('SSH-2.0-OpenSSH_8.9\r\n')));
        });
        return sock;
      });

      const result = await tcpBannerProbe('example.com', 22, 5000, true, () => sock as unknown as net.Socket);

      expect(result.reachable).toBe(true);
      expect(result.status).toBe('ssh_banner_received');
      expect(result.banner).toBe('SSH-2.0-OpenSSH_8.9');
      expect(result.latency_ms).toBeTypeOf('number');
    });

    it('mode=banner: TCP connect fails → unreachable', async () => {
      const sock = new FakeSocket();
      sock.connect = vi.fn(() => {
        setImmediate(() => sock.emit('error', new Error('ECONNREFUSED')));
        return sock;
      });

      const result = await tcpBannerProbe('down.example.com', 22, 5000, true, () => sock as unknown as net.Socket);

      expect(result.reachable).toBe(false);
      expect(result.status).toBe('tcp_unreachable');
      expect(result.error).toContain('ECONNREFUSED');
      expect(result.latency_ms).toBeNull();
    });

    it('mode=banner: TCP connects but no SSH banner → still reachable', async () => {
      const sock = new FakeSocket();
      // connect succeeds but no data event fires (the setTimeout fallback triggers)
      sock.connect = vi.fn((_p: number, _h: string, cb?: () => void) => {
        setImmediate(() => cb?.());
        return sock;
      });

      const result = await tcpBannerProbe('silent.example.com', 22, 500, true, () => sock as unknown as net.Socket);

      expect(result.reachable).toBe(true);
      expect(result.status).toBe('ssh_banner_received');
      expect(result.banner).toBeUndefined();
    });

    it('mode=tcp: just checks TCP open', async () => {
      const sock = new FakeSocket();
      sock.connect = vi.fn((_p: number, _h: string, cb?: () => void) => {
        setImmediate(() => cb?.());
        return sock;
      });

      const result = await tcpBannerProbe('tcp.example.com', 2222, 5000, false, () => sock as unknown as net.Socket);

      expect(result.reachable).toBe(true);
      expect(result.status).toBe('tcp_open');
      expect(result.latency_ms).toBeTypeOf('number');
    });

    it('timeout fires → tcp_unreachable', async () => {
      const sock = new FakeSocket();
      sock.connect = vi.fn(() => {
        // Simulate timeout after socket.setTimeout fires
        setImmediate(() => sock.emit('timeout'));
        return sock;
      });

      const result = await tcpBannerProbe('slow.example.com', 22, 100, true, () => sock as unknown as net.Socket);

      expect(result.reachable).toBe(false);
      expect(result.status).toBe('tcp_unreachable');
      expect(result.error).toContain('timed out');
    });
  });

  // ── sshCheckHost integration-level tests ──────────────────────────────

  describe('sshCheckHost', () => {
    it('default mode is banner', async () => {
      const sock = new FakeSocket();
      sock.connect = vi.fn((_p: number, _h: string, cb?: () => void) => {
        setImmediate(() => {
          cb?.();
          setImmediate(() => sock.emit('data', Buffer.from('SSH-2.0-Test\r\n')));
        });
        return sock;
      });

      // Inject the fake socket factory so sshCheckHost never opens a real connection.
      const result = await sshCheckHost(
        { host: 'example.com' },
        makeCredentialMap(),
        () => sock as unknown as import('net').Socket,
      );

      expect(result.reachable).toBe(true);
      expect(result.status).toBe('ssh_banner_received');
      expect(result.banner).toBe('SSH-2.0-Test');
      expect(result.status).not.toBe('auth_failed');
      expect(result.status).not.toBe('auth_succeeded');
    });

    it('mode=auth: auth_succeeded when ssh exits 0', async () => {
      execFileMock.mockResolvedValueOnce({ stdout: '', stderr: '' });

      const result = await sshCheckHost(
        { host: 'auth-ok.example.com', mode: 'auth', use_ssh_config: false },
        makeCredentialMap(),
      );

      expect(result.reachable).toBe(true);
      expect(result.status).toBe('auth_succeeded');
      expect(result.latency_ms).toBeTypeOf('number');
    });

    it('mode=auth: auth_failed when ssh exits 255', async () => {
      const err = Object.assign(new Error('Permission denied'), { code: 255 });
      execFileMock.mockRejectedValueOnce(err);

      const result = await sshCheckHost(
        { host: 'auth-fail.example.com', mode: 'auth', use_ssh_config: false },
        makeCredentialMap(),
      );

      expect(result.reachable).toBe(false);
      expect(result.status).toBe('auth_failed');
      expect(result.error).toContain('Permission denied');
    });

    it('mode=auth: auth_succeeded when ssh exits 1 (connected but exit returned non-zero)', async () => {
      const err = Object.assign(new Error('exit code 1'), { code: 1 });
      execFileMock.mockRejectedValueOnce(err);

      const result = await sshCheckHost(
        { host: 'exit1.example.com', mode: 'auth', use_ssh_config: false },
        makeCredentialMap(),
      );

      expect(result.reachable).toBe(true);
      expect(result.status).toBe('auth_succeeded');
    });

    it('ssh config resolution works with use_ssh_config=true', async () => {
      const { resolveSshConfig } = await import('../../src/ssh/ssh-config-reader.js');
      const mockResolve = vi.mocked(resolveSshConfig);
      mockResolve.mockResolvedValueOnce({
        hostname: 'real-host.example.com',
        user: 'sshuser',
        port: 2222,
        identityFiles: [],
      });

      // This will attempt a real TCP connection (which will fail), but we
      // verify ssh config was consulted
      const result = await sshCheckHost(
        { host: 'alias', use_ssh_config: true },
        makeCredentialMap(),
      );

      expect(mockResolve).toHaveBeenCalledWith('alias');
      // TCP will likely fail in CI
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('reachable');
    });
  });
});
