/**
 * Unit tests for ssh-config-reader.ts
 * Mocks execFile (via cli-resolver + child_process) to avoid calling real ssh.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock resolveSshBin ──────────────────────────────────────────────────────
vi.mock('../../src/utils/cli-resolver.js', () => ({
  resolveSshBin: vi.fn().mockResolvedValue('/usr/bin/ssh'),
  resolveSshPass: vi.fn().mockResolvedValue('/usr/bin/sshpass'),
}));

// ── Mock child_process.execFile ─────────────────────────────────────────────
const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: vi.fn((_bin, _args, _opts, cb) => {
    // promisify wraps execFile — we intercept the raw call here
    execFileMock(_bin, _args, _opts, cb);
  }),
}));

// ── Import AFTER mocks are set up ──────────────────────────────────────────
const { resolveSshConfig } = await import('../../src/ssh/ssh-config-reader.js');

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build fake `ssh -G` output lines as a multi-line string. */
function buildSshGOutput(overrides: Record<string, string | string[]> = {}): string {
  const defaults: Record<string, string | string[]> = {
    hostname: 'actual-host.example.com',
    user: 'alice',
    port: '22',
    identityfile: ['~/.ssh/id_rsa', '~/.ssh/id_ed25519'],
    proxyjump: 'none',
    proxycommand: 'none',
    connecttimeout: '0',
  };
  const merged = { ...defaults, ...overrides };

  const lines: string[] = [];
  for (const [key, val] of Object.entries(merged)) {
    if (Array.isArray(val)) {
      for (const v of val) lines.push(`${key} ${v}`);
    } else {
      lines.push(`${key} ${val}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Make execFileMock resolve with a given stdout string. */
function mockSshGSuccess(stdout: string): void {
  execFileMock.mockImplementation((_bin: string, _args: string[], _opts: object, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout, stderr: '' });
  });
}

/** Make execFileMock reject (simulates ssh -G failure). */
function mockSshGFailure(message = 'ssh -G failed'): void {
  execFileMock.mockImplementation((_bin: string, _args: string[], _opts: object, cb: (err: Error) => void) => {
    cb(new Error(message));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('resolveSshConfig', () => {
  it('returns hostname, user, port, identityFiles from ssh -G output', async () => {
    mockSshGSuccess(buildSshGOutput({
      hostname: 'real-host.corp.example.com',
      user: 'deploy',
      port: '2222',
      identityfile: ['~/.ssh/deploy_key'],
    }));

    const cfg = await resolveSshConfig('my-alias');

    expect(cfg).not.toBeNull();
    expect(cfg!.hostname).toBe('real-host.corp.example.com');
    expect(cfg!.user).toBe('deploy');
    expect(cfg!.port).toBe(2222);
    expect(cfg!.identityFiles).toContain('~/.ssh/deploy_key');
  });

  it('resolves proxyJump when set', async () => {
    mockSshGSuccess(buildSshGOutput({
      proxyjump: 'bastion.example.com',
    }));

    const cfg = await resolveSshConfig('internal-host');
    expect(cfg!.proxyJump).toBe('bastion.example.com');
  });

  it('sets proxyJump to undefined when value is "none"', async () => {
    mockSshGSuccess(buildSshGOutput({ proxyjump: 'none' }));
    const cfg = await resolveSshConfig('some-host');
    expect(cfg!.proxyJump).toBeUndefined();
  });

  it('sets proxyCommand to undefined when value is "none"', async () => {
    mockSshGSuccess(buildSshGOutput({ proxycommand: 'none' }));
    const cfg = await resolveSshConfig('some-host');
    expect(cfg!.proxyCommand).toBeUndefined();
  });

  it('collects multiple identityfile entries', async () => {
    mockSshGSuccess(buildSshGOutput({
      identityfile: ['~/.ssh/id_rsa', '~/.ssh/id_ed25519', '~/.ssh/corp_key'],
    }));

    const cfg = await resolveSshConfig('multi-key-host');
    expect(cfg!.identityFiles).toHaveLength(3);
    expect(cfg!.identityFiles).toContain('~/.ssh/corp_key');
  });

  it('filters out "none" identityfile entries', async () => {
    mockSshGSuccess(buildSshGOutput({
      identityfile: 'none',
    }));
    const cfg = await resolveSshConfig('no-key-host');
    expect(cfg!.identityFiles).toHaveLength(0);
  });

  it('returns null when ssh -G fails', async () => {
    mockSshGFailure('No such file or directory');
    const cfg = await resolveSshConfig('unknown-host');
    expect(cfg).toBeNull();
  });

  it('parses connectTimeout when set', async () => {
    mockSshGSuccess(buildSshGOutput({ connecttimeout: '15' }));
    const cfg = await resolveSshConfig('slow-host');
    expect(cfg!.connectTimeout).toBe(15);
  });

  it('leaves connectTimeout undefined when value is 0', async () => {
    mockSshGSuccess(buildSshGOutput({ connecttimeout: '0' }));
    const cfg = await resolveSshConfig('default-host');
    expect(cfg!.connectTimeout).toBeUndefined();
  });

  it('falls back to original host when hostname line is missing', async () => {
    // Minimal output with no hostname line
    mockSshGSuccess('user alice\nport 22\n');
    const cfg = await resolveSshConfig('my-alias');
    expect(cfg!.hostname).toBe('my-alias');
  });

  it('returns null when resolveSshBin throws', async () => {
    const { resolveSshBin } = await import('../../src/utils/cli-resolver.js');
    vi.mocked(resolveSshBin).mockRejectedValueOnce(new Error('ssh not found'));

    const cfg = await resolveSshConfig('some-host');
    expect(cfg).toBeNull();
  });
});
