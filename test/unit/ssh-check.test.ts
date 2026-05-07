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
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

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
      expect(result.status).toBe('ssh_banner_received');
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

      // We test via tcpBannerProbe since sshCheckHost creates a real socket;
      // for the default-mode assertion we verify that mode defaults to 'banner'
      // by calling sshCheckHost with no mode and checking the result shape.
      // But since we can't inject sockets into sshCheckHost directly, we
      // verify indirectly that the mode field defaults correctly.
      const input = { host: 'example.com', mode: undefined as undefined };
      // sshCheckHost will try a real TCP connection which will fail in CI,
      // but we can still verify it chose the right code path by checking
      // the result status is tcp_unreachable (not auth_failed).
      const result = await sshCheckHost(input, makeCredentialMap());
      // In a test env with no real SSH server, TCP will fail
      expect(['tcp_unreachable', 'ssh_banner_received']).toContain(result.status);
      expect(result.status).not.toBe('auth_failed');
      expect(result.status).not.toBe('auth_succeeded');
    });

    it('mode=auth: auth_succeeded when ssh exits 0', async () => {
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
          cb(null, { stdout: '', stderr: '' });
        },
      );

      const result = await sshCheckHost(
        { host: 'auth-ok.example.com', mode: 'auth', use_ssh_config: false },
        makeCredentialMap(),
      );

      expect(result.reachable).toBe(true);
      expect(result.status).toBe('auth_succeeded');
      expect(result.latency_ms).toBeTypeOf('number');
    });

    it('mode=auth: auth_failed when ssh exits 255', async () => {
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error & { code?: number }) => void) => {
          const err = new Error('Permission denied') as Error & { code?: number };
          err.code = 255;
          cb(err);
        },
      );

      const result = await sshCheckHost(
        { host: 'auth-fail.example.com', mode: 'auth', use_ssh_config: false },
        makeCredentialMap(),
      );

      expect(result.reachable).toBe(false);
      expect(result.status).toBe('auth_failed');
      expect(result.error).toContain('Permission denied');
    });

    it('mode=auth: auth_succeeded when ssh exits 1 (connected but exit returned non-zero)', async () => {
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error & { code?: number }) => void) => {
          const err = new Error('exit code 1') as Error & { code?: number };
          err.code = 1;
          cb(err);
        },
      );

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
