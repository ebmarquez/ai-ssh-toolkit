/**
 * Unit tests for ssh-transfer tools (ssh_upload, ssh_download, ssh_sftp_list).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CredentialRegistry } from '../../src/credentials/registry.js';
import type { CredentialMap } from '../../src/credentials/credential-map.js';

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
    execFileSync: actual.execFileSync,
  };
});

// Mock cli-resolver to avoid real binary lookups
vi.mock('../../src/utils/cli-resolver.js', () => ({
  resolveCliPath: (name: string) => `/usr/bin/${name}`,
}));

// Mock ssh-config-reader
vi.mock('../../src/ssh/ssh-config-reader.js', () => ({
  resolveSshConfig: vi.fn().mockResolvedValue(null),
}));

import { sshUpload, sshDownload, sshSftpList, parseSftpListing, runSftp } from '../../src/tools/ssh-transfer.js';
import type { SshUploadInput } from '../../src/tools/ssh-transfer.js';
import { EventEmitter, PassThrough, Writable } from 'stream';

// ── Test helpers ─────────────────────────────────────────────────────────────

function createMockRegistry(opts?: {
  username?: string;
  password?: string;
  available?: boolean;
}): CredentialRegistry {
  const { username = 'testuser', password = 'testpass', available = true } = opts ?? {};
  const mockBackend = {
    name: 'test-backend',
    isAvailable: vi.fn().mockResolvedValue(available),
    getCredential: vi.fn().mockResolvedValue({
      username,
      password: Buffer.from(password),
    }),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
  return {
    getBackend: vi.fn().mockReturnValue(mockBackend),
    getCredential: vi.fn(),
    register: vi.fn(),
    listBackends: vi.fn(),
  } as unknown as CredentialRegistry;
}

function createMockCredentialMap(mapped?: { backend: string; ref: string; username?: string }): CredentialMap {
  return {
    resolve: vi.fn().mockReturnValue(mapped ?? null),
    reload: vi.fn(),
    getFilePath: vi.fn(),
  } as unknown as CredentialMap;
}

interface MockChildProcess extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: Writable & { writtenData: string[] };
  kill: ReturnType<typeof vi.fn>;
}

function createMockChild(opts?: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  emitError?: Error;
}): MockChildProcess {
  const { exitCode = 0, stdout = '', stderr = '', emitError } = opts ?? {};

  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  const writtenData: string[] = [];
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      writtenData.push(chunk.toString());
      callback();
    },
  }) as MockChildProcess['stdin'];
  child.stdin.writtenData = writtenData;
  child.kill = vi.fn();

  // Emit data then close asynchronously — use setTimeout(0) to ensure
  // spawn callers have attached 'data' listeners before we push data.
  setTimeout(() => {
    if (emitError) {
      child.emit('error', emitError);
      return;
    }
    if (stdout) child.stdout.write(stdout);
    child.stdout.end();
    if (stderr) child.stderr.write(stderr);
    child.stderr.end();
    // Give 'data' events a chance to fire before 'close'
    setTimeout(() => child.emit('close', exitCode), 0);
  }, 0);

  return child;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('parseSftpListing', () => {
  it('parses standard ls -la output', () => {
    const output = [
      'total 8',
      'drwxr-xr-x    2 root  root     4096 Jan  1 12:00 subdir',
      '-rw-r--r--    1 root  root     1234 Feb 15 09:30 file.txt',
      'lrwxrwxrwx    1 root  root       10 Mar  3 14:00 link -> target',
    ].join('\n');

    const entries = parseSftpListing(output);
    expect(entries).toHaveLength(3);

    expect(entries[0]).toEqual({
      name: 'subdir',
      type: 'directory',
      size: 4096,
      permissions: 'drwxr-xr-x',
      modified: 'Jan  1 12:00',
    });

    expect(entries[1]).toEqual({
      name: 'file.txt',
      type: 'file',
      size: 1234,
      permissions: '-rw-r--r--',
      modified: 'Feb 15 09:30',
    });

    expect(entries[2]).toEqual({
      name: 'link',
      type: 'symlink',
      size: 10,
      permissions: 'lrwxrwxrwx',
      modified: 'Mar  3 14:00',
    });
  });

  it('skips . and .. entries', () => {
    const output = [
      'drwxr-xr-x    2 root  root     4096 Jan  1 12:00 .',
      'drwxr-xr-x    3 root  root     4096 Jan  1 12:00 ..',
      '-rw-r--r--    1 root  root       42 Jan  1 12:00 data.txt',
    ].join('\n');

    const entries = parseSftpListing(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('data.txt');
  });

  it('skips unparseable lines', () => {
    const output = [
      'some random text',
      '-rw-r--r--    1 root  root     100 Jan  1 12:00 valid.txt',
      'another garbage line',
    ].join('\n');

    const entries = parseSftpListing(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('valid.txt');
  });

  it('returns empty array for empty output', () => {
    expect(parseSftpListing('')).toEqual([]);
  });

  it('handles filenames with spaces', () => {
    const output = '-rw-r--r--    1 root  root     100 Jan  1 12:00 my file name.txt';
    const entries = parseSftpListing(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('my file name.txt');
  });
});

describe('runSftp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs sftp in batch mode without password (key-based auth)', async () => {
    const child = createMockChild({ stdout: 'ok\n' });
    mockSpawn.mockReturnValue(child);

    const result = await runSftp({
      host: 'example.com',
      username: 'user',
      password: Buffer.alloc(0),
      batchCommands: 'ls /tmp',
      timeoutMs: 5000,
    });

    expect(result.stdout).toBe('ok\n');
    expect(mockSpawn).toHaveBeenCalledOnce();

    // Should use sftp binary directly (no sshpass)
    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('/usr/bin/sftp');
    expect(args).toContain('-o');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('user@example.com');

    // Verify batch commands were sent to stdin
    expect(child.stdin.writtenData.join('')).toContain('ls /tmp');
  });

  it('uses sshpass when password is provided', async () => {
    const child = createMockChild({ stdout: 'transferred\n' });
    mockSpawn.mockReturnValue(child);

    await runSftp({
      host: 'host.test',
      username: 'admin',
      password: Buffer.from('secret'),
      batchCommands: 'put /local /remote',
      timeoutMs: 5000,
    });

    const [cmd, args, spawnOpts] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('/usr/bin/sshpass');
    expect(args[0]).toBe('-e');
    expect(args[1]).toBe('/usr/bin/sftp');
    expect(spawnOpts.env.SSHPASS).toBe('secret');
  });

  it('includes port when non-default', async () => {
    const child = createMockChild({ stdout: '' });
    mockSpawn.mockReturnValue(child);

    await runSftp({
      host: 'host.test',
      username: 'user',
      password: Buffer.alloc(0),
      port: 2222,
      batchCommands: 'ls /',
      timeoutMs: 5000,
    });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('-P');
    expect(args).toContain('2222');
  });

  it('rejects on non-zero exit code', async () => {
    const child = createMockChild({ exitCode: 1, stderr: 'Connection refused' });
    mockSpawn.mockReturnValue(child);

    await expect(runSftp({
      host: 'host.test',
      username: 'user',
      password: Buffer.alloc(0),
      batchCommands: 'ls /',
      timeoutMs: 5000,
    })).rejects.toThrow('Connection refused');
  });

  it('rejects on spawn error', async () => {
    const child = createMockChild({ emitError: new Error('ENOENT') });
    mockSpawn.mockReturnValue(child);

    await expect(runSftp({
      host: 'host.test',
      username: 'user',
      password: Buffer.alloc(0),
      batchCommands: 'ls /',
      timeoutMs: 5000,
    })).rejects.toThrow('Failed to spawn sftp');
  });

  it('rejects on timeout', async () => {
    vi.useFakeTimers();

    // Create a child that never emits close
    const child = new EventEmitter() as MockChildProcess;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const writtenData: string[] = [];
    child.stdin = new Writable({
      write(chunk, _enc, cb) { writtenData.push(chunk.toString()); cb(); },
    }) as MockChildProcess['stdin'];
    child.stdin.writtenData = writtenData;
    child.kill = vi.fn();
    mockSpawn.mockReturnValue(child);

    const promise = runSftp({
      host: 'host.test',
      username: 'user',
      password: Buffer.alloc(0),
      batchCommands: 'ls /',
      timeoutMs: 1000,
    });

    vi.advanceTimersByTime(1001);

    await expect(promise).rejects.toThrow('timed out');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    vi.useRealTimers();
  });
});

describe('sshUpload', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uploads a file successfully', async () => {
    const child = createMockChild({ stdout: '' });
    mockSpawn.mockReturnValue(child);

    const registry = createMockRegistry();
    const credMap = createMockCredentialMap();
    const input: SshUploadInput = {
      host: 'server.test',
      local_path: '/tmp/file.txt',
      remote_path: '/home/user/file.txt',
      username: 'testuser',
    };

    const result = await sshUpload(registry, input, credMap);
    expect(result.success).toBe(true);
    expect(result.local_path).toBe('/tmp/file.txt');
    expect(result.remote_path).toBe('/home/user/file.txt');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);

    // Verify batch command contains put
    const stdinData = child.stdin.writtenData.join('');
    expect(stdinData).toContain('put');
  });

  it('throws on empty host', async () => {
    const registry = createMockRegistry();
    const credMap = createMockCredentialMap();

    await expect(sshUpload(registry, {
      host: '',
      local_path: '/tmp/f',
      remote_path: '/remote/f',
      username: 'user',
    }, credMap)).rejects.toThrow('host is required');
  });

  it('throws on path with newlines', async () => {
    const registry = createMockRegistry();
    const credMap = createMockCredentialMap();

    await expect(sshUpload(registry, {
      host: 'server',
      local_path: '/tmp/file\n.txt',
      remote_path: '/remote/file.txt',
      username: 'user',
    }, credMap)).rejects.toThrow('must not contain newline');
  });

  it('resolves credentials from credential map', async () => {
    const child = createMockChild({ stdout: '' });
    mockSpawn.mockReturnValue(child);

    const registry = createMockRegistry();
    const credMap = createMockCredentialMap({
      backend: 'test-backend',
      ref: 'my-secret',
      username: 'mapuser',
    });

    await sshUpload(registry, {
      host: 'server.test',
      local_path: '/tmp/f',
      remote_path: '/remote/f',
    }, credMap);

    expect(credMap.resolve).toHaveBeenCalledWith('server.test');
    expect(registry.getBackend).toHaveBeenCalledWith('test-backend');
  });

  it('zeros password buffer after transfer', async () => {
    const child = createMockChild({ stdout: '' });
    mockSpawn.mockReturnValue(child);

    const passwordBuf = Buffer.from('mysecret');
    const mockBackend = {
      name: 'test-backend',
      isAvailable: vi.fn().mockResolvedValue(true),
      getCredential: vi.fn().mockResolvedValue({
        username: 'user',
        password: passwordBuf,
      }),
      cleanup: vi.fn().mockResolvedValue(undefined),
    };
    const registry = {
      getBackend: vi.fn().mockReturnValue(mockBackend),
    } as unknown as CredentialRegistry;
    const credMap = createMockCredentialMap();

    await sshUpload(registry, {
      host: 'server.test',
      local_path: '/tmp/f',
      remote_path: '/remote/f',
      credential_backend: 'test-backend',
      credential_ref: 'my-ref',
    }, credMap);

    // The original password buffer should have been zeroed by resolveAuth
    expect(passwordBuf.every(b => b === 0)).toBe(true);
  });
});

describe('sshDownload', () => {
  beforeEach(() => vi.clearAllMocks());

  it('downloads a file successfully', async () => {
    const child = createMockChild({ stdout: '' });
    mockSpawn.mockReturnValue(child);

    const registry = createMockRegistry();
    const credMap = createMockCredentialMap();

    const result = await sshDownload(registry, {
      host: 'server.test',
      remote_path: '/remote/data.csv',
      local_path: '/tmp/data.csv',
      username: 'user',
    }, credMap);

    expect(result.success).toBe(true);
    expect(result.remote_path).toBe('/remote/data.csv');
    expect(result.local_path).toBe('/tmp/data.csv');

    const stdinData = child.stdin.writtenData.join('');
    expect(stdinData).toContain('get');
  });

  it('throws on missing remote_path', async () => {
    const registry = createMockRegistry();
    const credMap = createMockCredentialMap();

    await expect(sshDownload(registry, {
      host: 'server',
      remote_path: '',
      local_path: '/tmp/f',
      username: 'user',
    }, credMap)).rejects.toThrow('remote_path is required');
  });
});

describe('sshSftpList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists directory contents', async () => {
    const lsOutput = [
      'total 12',
      'drwxr-xr-x    2 root  root     4096 Jan  1 12:00 subdir',
      '-rw-r--r--    1 root  root     1234 Feb 15 09:30 file.txt',
    ].join('\n');

    const child = createMockChild({ stdout: lsOutput });
    mockSpawn.mockReturnValue(child);

    const registry = createMockRegistry();
    const credMap = createMockCredentialMap();

    const result = await sshSftpList(registry, {
      host: 'server.test',
      remote_path: '/var/data',
      username: 'user',
    }, credMap);

    expect(result.path).toBe('/var/data');
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.entries[0].name).toBe('subdir');
    expect(result.entries[0].type).toBe('directory');
    expect(result.entries[1].name).toBe('file.txt');
    expect(result.entries[1].type).toBe('file');
  });

  it('truncates at 200 entries', async () => {
    const lines = ['total 999'];
    for (let i = 0; i < 250; i++) {
      lines.push(`-rw-r--r--    1 root  root     ${i} Jan  1 12:00 file${i}.txt`);
    }
    const child = createMockChild({ stdout: lines.join('\n') });
    mockSpawn.mockReturnValue(child);

    const registry = createMockRegistry();
    const credMap = createMockCredentialMap();

    const result = await sshSftpList(registry, {
      host: 'server.test',
      remote_path: '/big',
      username: 'user',
    }, credMap);

    expect(result.entries).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it('uses recursive flag', async () => {
    const child = createMockChild({ stdout: '' });
    mockSpawn.mockReturnValue(child);

    const registry = createMockRegistry();
    const credMap = createMockCredentialMap();

    await sshSftpList(registry, {
      host: 'server.test',
      remote_path: '/data',
      recursive: true,
      username: 'user',
    }, credMap);

    const stdinData = child.stdin.writtenData.join('');
    expect(stdinData).toContain('-Rla');
  });

  it('propagates sftp errors', async () => {
    const child = createMockChild({ exitCode: 1, stderr: 'No such file or directory' });
    mockSpawn.mockReturnValue(child);

    const registry = createMockRegistry();
    const credMap = createMockCredentialMap();

    await expect(sshSftpList(registry, {
      host: 'server.test',
      remote_path: '/nonexistent',
      username: 'user',
    }, credMap)).rejects.toThrow('No such file or directory');
  });
});
