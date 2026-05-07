/**
 * Unit tests for ssh_execute dry_run mode.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SshExecuteInput, SshExecuteDryRunResult } from '../../src/tools/ssh-execute.js';
import type { CredentialRegistry } from '../../src/credentials/registry.js';
import type { CredentialMap } from '../../src/credentials/credential-map.js';

// ── Mock ssh-config-reader ──────────────────────────────────────────────────
const mockResolveSshConfig = vi.fn();
vi.mock('../../src/ssh/ssh-config-reader.js', () => ({
  resolveSshConfig: (...args: unknown[]) => mockResolveSshConfig(...args),
}));

// ── Mock pty-manager (should never be called in dry_run) ────────────────────
const mockRunSshSession = vi.fn();
vi.mock('../../src/ssh/pty-manager.js', () => ({
  runSshSession: (...args: unknown[]) => mockRunSshSession(...args),
}));

// Import after mocks
const { sshExecute } = await import('../../src/tools/ssh-execute.js');

function makeRegistry(overrides: Partial<{
  isAvailable: boolean;
  backendExists: boolean;
}> = {}): CredentialRegistry {
  const { isAvailable = true, backendExists = true } = overrides;
  const backend = {
    name: 'test-backend',
    isAvailable: vi.fn().mockResolvedValue(isAvailable),
    getCredential: vi.fn(),
    getMetadata: vi.fn(),
    cleanup: vi.fn(),
  };
  return {
    getBackend: vi.fn((name: string) => {
      if (!backendExists) throw new Error(`Unknown credential backend: ${name}`);
      return backend;
    }),
  } as unknown as CredentialRegistry;
}

function makeCredentialMap(resolution?: { backend: string; ref: string; username?: string }): CredentialMap {
  return {
    resolve: vi.fn().mockReturnValue(resolution ?? null),
  } as unknown as CredentialMap;
}

function makeInput(overrides: Partial<SshExecuteInput> = {}): SshExecuteInput {
  return {
    host: 'myhost.example.com',
    command: 'uptime',
    dry_run: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSshConfig.mockResolvedValue(null);
  mockRunSshSession.mockReset();
});

describe('sshExecute dry_run', () => {
  it('returns dry_run result with basic fields', async () => {
    const result = await sshExecute(
      makeRegistry(),
      makeInput({ username: 'admin' }),
      makeCredentialMap(),
    ) as SshExecuteDryRunResult;

    expect(result.dry_run).toBe(true);
    expect(result.resolved_host).toBe('myhost.example.com');
    expect(result.resolved_user).toBe('admin');
    expect(result.resolved_port).toBe(22);
    expect(result.credential_backend).toBeNull();
    expect(result.credential_ref).toBeNull();
    expect(result.jump_hosts_resolved).toBeNull();
    expect(result.ssh_command_preview).toContain('ssh');
    expect(result.ssh_command_preview).toContain('admin@myhost.example.com');
    expect(result.ssh_command_preview).toContain('uptime');
  });

  it('does NOT call runSshSession', async () => {
    await sshExecute(
      makeRegistry(),
      makeInput({ username: 'admin' }),
      makeCredentialMap(),
    );

    expect(mockRunSshSession).not.toHaveBeenCalled();
  });

  it('resolves SSH config when use_ssh_config is true', async () => {
    mockResolveSshConfig.mockResolvedValue({
      hostname: '10.0.0.1',
      user: 'resolved-user',
      port: 2222,
      identityFiles: [],
      proxyJump: 'bastion.example.com',
    });

    const result = await sshExecute(
      makeRegistry(),
      makeInput({ use_ssh_config: true }),
      makeCredentialMap(),
    ) as SshExecuteDryRunResult;

    expect(result.resolved_host).toBe('10.0.0.1');
    expect(result.resolved_user).toBe('resolved-user');
    expect(result.resolved_port).toBe(2222);
    expect(result.jump_hosts_resolved).toBe('bastion.example.com');
    expect(result.ssh_command_preview).toContain('-p');
    expect(result.ssh_command_preview).toContain('2222');
  });

  it('skips SSH config when use_ssh_config is false', async () => {
    const result = await sshExecute(
      makeRegistry(),
      makeInput({ username: 'admin', use_ssh_config: false }),
      makeCredentialMap(),
    ) as SshExecuteDryRunResult;

    expect(mockResolveSshConfig).not.toHaveBeenCalled();
    expect(result.resolved_host).toBe('myhost.example.com');
    expect(result.resolved_user).toBe('admin');
  });

  it('uses credential map fallback', async () => {
    const result = await sshExecute(
      makeRegistry(),
      makeInput(),
      makeCredentialMap({ backend: 'env', ref: 'MY_SECRET', username: 'mapped-user' }),
    ) as SshExecuteDryRunResult;

    expect(result.credential_backend).toBe('env');
    expect(result.credential_ref).toBe('MY_SECRET');
    expect(result.resolved_user).toBe('mapped-user');
  });

  it('verifies backend availability without fetching credentials', async () => {
    const registry = makeRegistry();
    const result = await sshExecute(
      registry,
      makeInput({ credential_ref: 'some/secret', credential_backend: 'test-backend' }),
      makeCredentialMap(),
    ) as SshExecuteDryRunResult;

    expect(result.dry_run).toBe(true);
    expect(result.credential_backend).toBe('test-backend');
    expect(result.credential_ref).toBe('some/secret');
    // getCredential should NOT have been called
    const backend = (registry.getBackend as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(backend.isAvailable).toHaveBeenCalled();
    expect(backend.getCredential).not.toHaveBeenCalled();
  });

  it('throws when credential backend is unavailable', async () => {
    await expect(
      sshExecute(
        makeRegistry({ isAvailable: false }),
        makeInput({ credential_ref: 'some/secret', credential_backend: 'test-backend' }),
        makeCredentialMap(),
      ),
    ).rejects.toThrow(/backend.*failed/i);
  });

  it('throws when credential_ref is empty string', async () => {
    await expect(
      sshExecute(
        makeRegistry(),
        makeInput({ credential_ref: '  ', credential_backend: 'test-backend' }),
        makeCredentialMap(),
      ),
    ).rejects.toThrow(/credential_ref cannot be empty/);
  });

  it('shows <unresolved> when no username available', async () => {
    const result = await sshExecute(
      makeRegistry(),
      makeInput(),
      makeCredentialMap(),
    ) as SshExecuteDryRunResult;

    expect(result.resolved_user).toBe('<unresolved>');
    expect(result.ssh_command_preview).toContain('<unresolved>@myhost.example.com');
  });

  it('tool-provided username overrides ssh config user', async () => {
    mockResolveSshConfig.mockResolvedValue({
      hostname: '10.0.0.1',
      user: 'config-user',
      port: 22,
      identityFiles: [],
    });

    const result = await sshExecute(
      makeRegistry(),
      makeInput({ username: 'explicit-user' }),
      makeCredentialMap(),
    ) as SshExecuteDryRunResult;

    expect(result.resolved_user).toBe('explicit-user');
  });

  it('includes standard ssh options in command preview', async () => {
    const result = await sshExecute(
      makeRegistry(),
      makeInput({ username: 'admin' }),
      makeCredentialMap(),
    ) as SshExecuteDryRunResult;

    expect(result.ssh_command_preview).toEqual([
      'ssh',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'NumberOfPasswordPrompts=1',
      '-o', 'ConnectTimeout=10',
      '--', 'admin@myhost.example.com', 'uptime',
    ]);
  });
});
