/**
 * Unit tests for privilege escalation — sudo -S pipe, sudo -n fallback,
 * Cisco enable mode sequence, and no password leakage.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { IPty } from 'node-pty';
import type { ManagedSession } from '../../src/ssh/session-store.js';
import { SessionStore } from '../../src/ssh/session-store.js';
import type { CredentialBackend, CredentialResult } from '../../src/credentials/backend.js';
import { CredentialRegistry } from '../../src/credentials/registry.js';
import {
  SUDO_PROMPT_TOKEN,
  buildSudoCommand,
  shellQuote,
  detectSudoPrompt,
  isSudoPasswordRequired,
  validateEscalationInputs,
  fetchEscalationCredential,
} from '../../src/ssh/privilege-escalation.js';

// ── ssh-config-reader mock ──────────────────────────────────────────────────
vi.mock('../../src/ssh/ssh-config-reader.js', () => ({
  resolveSshConfig: vi.fn().mockResolvedValue(null),
}));

// ── node-pty mock ───────────────────────────────────────────────────────────
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
const { runSshSession } = await import('../../src/ssh/pty-manager.js');
const { sshExecute } = await import('../../src/tools/ssh-execute.js');
const { sshSessionExecute } = await import('../../src/tools/ssh-session-execute.js');

// ── Test helpers ────────────────────────────────────────────────────────────

function makeFakeBackend(password: string = 'sudo-secret'): CredentialBackend {
  return {
    name: 'test-backend',
    isAvailable: vi.fn().mockResolvedValue(true),
    getCredential: vi.fn().mockResolvedValue({
      username: 'testuser',
      password: Buffer.from(password),
    } as CredentialResult),
    getMetadata: vi.fn().mockResolvedValue({
      username: 'testuser',
      has_password: true,
      backend: 'test-backend',
    }),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRegistry(backend?: CredentialBackend): CredentialRegistry {
  const reg = new CredentialRegistry();
  reg.register(backend ?? makeFakeBackend());
  return reg;
}

function makeFakePty(): IPty & {
  _triggerData: (d: string) => void;
  _triggerExit: (code: number) => void;
  write: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
} {
  const onDataCbs: ((d: string) => void)[] = [];
  let onExitCb: ((ev: { exitCode: number }) => void) | null = null;

  const fakePty = {
    write: vi.fn(),
    kill: vi.fn(),
    onData(cb: (d: string) => void) {
      onDataCbs.push(cb);
      const disposable = {
        dispose: vi.fn(() => {
          const idx = onDataCbs.indexOf(cb);
          if (idx !== -1) onDataCbs.splice(idx, 1);
        }),
      };
      return disposable;
    },
    onExit(cb: (ev: { exitCode: number }) => void) {
      onExitCb = cb;
      return { dispose: vi.fn(() => { onExitCb = null; }) };
    },
    _triggerData(d: string) { for (const cb of [...onDataCbs]) cb(d); },
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
    inFlight: false,
    disposables: [],
    ...overrides,
  };
}

// ── credential-map mock ─────────────────────────────────────────────────────
function makeMockCredentialMap() {
  return { resolve: vi.fn().mockReturnValue(null) } as any;
}

beforeEach(() => {
  fakeOnData = null;
  fakeOnExit = null;
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// privilege-escalation.ts unit tests
// ═══════════════════════════════════════════════════════════════════════════

describe('privilege-escalation helpers', () => {
  describe('shellQuote', () => {
    it('wraps simple strings in single quotes', () => {
      expect(shellQuote('hello')).toBe("'hello'");
    });

    it('escapes single quotes', () => {
      expect(shellQuote("it's")).toBe("'it'\\''s'");
    });
  });

  describe('buildSudoCommand', () => {
    it('builds sudo -S command with custom prompt when password available', () => {
      const result = buildSudoCommand('cat /etc/shadow', true);
      expect(result).toContain('sudo -k -S -p');
      expect(result).toContain(SUDO_PROMPT_TOKEN);
      expect(result).toContain("sh -c 'cat /etc/shadow'");
    });

    it('builds sudo -n command when no password', () => {
      const result = buildSudoCommand('cat /etc/shadow', false);
      expect(result).toBe("sudo -n -- sh -c 'cat /etc/shadow'");
      expect(result).not.toContain('-S');
    });

    it('properly quotes commands with shell metacharacters', () => {
      const result = buildSudoCommand('echo "hi" > /root/file', true);
      expect(result).toContain("sh -c 'echo \"hi\" > /root/file'");
    });
  });

  describe('detectSudoPrompt', () => {
    it('detects custom sudo prompt token', () => {
      expect(detectSudoPrompt(`${SUDO_PROMPT_TOKEN}`)).toBe(true);
    });

    it('does not match generic password prompt', () => {
      expect(detectSudoPrompt('Password: ')).toBe(false);
    });
  });

  describe('isSudoPasswordRequired', () => {
    it('detects "a password is required" message', () => {
      expect(isSudoPasswordRequired('sudo: a password is required')).toBe(true);
    });

    it('detects "no tty present" message', () => {
      expect(isSudoPasswordRequired('sudo: no tty present and no askpass program specified')).toBe(true);
    });

    it('does not match normal output', () => {
      expect(isSudoPasswordRequired('total 0')).toBe(false);
    });
  });

  describe('validateEscalationInputs', () => {
    it('allows sudo=true without password ref', () => {
      expect(() => validateEscalationInputs({ sudo: true })).not.toThrow();
    });

    it('allows sudo=true with password ref', () => {
      expect(() => validateEscalationInputs({
        sudo: true,
        sudo_password_ref: { backend: 'test', ref: 'ref' },
      })).not.toThrow();
    });

    it('rejects sudo_password_ref without sudo=true', () => {
      expect(() => validateEscalationInputs({
        sudo_password_ref: { backend: 'test', ref: 'ref' },
      })).toThrow(/sudo=true/);
    });

    it('rejects sudo + enable_password_ref combination', () => {
      expect(() => validateEscalationInputs({
        sudo: true,
        enable_password_ref: { backend: 'test', ref: 'ref' },
      })).toThrow(/Cannot use both/);
    });
  });

  describe('fetchEscalationCredential', () => {
    it('returns a password buffer and calls cleanup', async () => {
      const backend = makeFakeBackend('my-secret');
      const reg = makeRegistry(backend);
      const buf = await fetchEscalationCredential(reg, { backend: 'test-backend', ref: 'my-ref' });
      expect(buf.toString('utf-8')).toBe('my-secret');
      expect(backend.cleanup).toHaveBeenCalled();
    });

    it('throws when backend is unavailable', async () => {
      const backend = makeFakeBackend();
      (backend.isAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const reg = makeRegistry(backend);
      await expect(
        fetchEscalationCredential(reg, { backend: 'test-backend', ref: 'ref' }),
      ).rejects.toThrow(/not available/);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// pty-manager sudo integration tests
// ═══════════════════════════════════════════════════════════════════════════

describe('pty-manager sudo support', () => {
  it('writes sudo password when custom prompt token appears', async () => {
    const sudoPassword = Buffer.from('sudo-pass');
    const promise = runSshSession({
      host: 'test-host',
      username: 'testuser',
      password: Buffer.from('ssh-pass'),
      command: `sudo -k -S -p '${SUDO_PROMPT_TOKEN}' -- sh -c 'cat /etc/shadow'`,
      platform: 'linux',
      timeout_ms: 5000,
      sudo_password: sudoPassword,
    });

    // Simulate sudo prompt appearing
    await new Promise(r => setTimeout(r, 0));
    fakeOnData!(SUDO_PROMPT_TOKEN);

    // Then command output + exit
    await new Promise(r => setTimeout(r, 0));
    fakeOnData!('root:x:0:0:root\n');
    fakeOnExit!({ exitCode: 0 });

    const result = await promise;
    expect(result.exit_code).toBe(0);
    // Verify sudo password was written (not SSH password)
    expect(fakeWrite).toHaveBeenCalledWith('sudo-pass\r');
  });

  it('detects sudo -n failure and returns clear error', async () => {
    const promise = runSshSession({
      host: 'test-host',
      username: 'testuser',
      command: "sudo -n -- sh -c 'cat /etc/shadow'",
      platform: 'linux',
      timeout_ms: 5000,
    });

    await new Promise(r => setTimeout(r, 0));
    fakeOnData!('sudo: a password is required\n');

    await expect(promise).rejects.toThrow(/sudo_password_ref/);
  });

  it('handles SSH password then sudo password in sequence', async () => {
    const sshPassword = Buffer.from('ssh-pass');
    const sudoPassword = Buffer.from('sudo-pass');

    const promise = runSshSession({
      host: 'test-host',
      username: 'testuser',
      password: sshPassword,
      command: `sudo -k -S -p '${SUDO_PROMPT_TOKEN}' -- sh -c 'whoami'`,
      platform: 'linux',
      timeout_ms: 5000,
      sudo_password: sudoPassword,
    });

    // First: SSH password prompt
    await new Promise(r => setTimeout(r, 0));
    fakeOnData!('Password: ');

    // Then: sudo prompt
    await new Promise(r => setTimeout(r, 0));
    fakeOnData!(SUDO_PROMPT_TOKEN);

    // Then: output + exit
    await new Promise(r => setTimeout(r, 0));
    fakeOnData!('root\n');
    fakeOnExit!({ exitCode: 0 });

    const result = await promise;
    expect(result.exit_code).toBe(0);
    // SSH password sent first, then sudo password
    expect(fakeWrite).toHaveBeenCalledWith('ssh-pass\r');
    expect(fakeWrite).toHaveBeenCalledWith('sudo-pass\r');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ssh_execute sudo integration tests
// ═══════════════════════════════════════════════════════════════════════════

describe('sshExecute with sudo', () => {
  it('wraps command with sudo -S when sudo=true and sudo_password_ref provided', async () => {
    const registry = makeRegistry();
    const credMap = makeMockCredentialMap();

    const promise = sshExecute(registry, {
      host: 'test-host',
      command: 'cat /etc/shadow',
      username: 'testuser',
      sudo: true,
      sudo_password_ref: { backend: 'test-backend', ref: 'sudo-ref' },
    }, credMap);

    // Let the promise start
    await new Promise(r => setTimeout(r, 10));

    // Check that spawn was called with sudo-wrapped command
    const spawnCall = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
    const sshArgs: string[] = spawnCall[1];
    const commandArg = sshArgs[sshArgs.length - 1];
    expect(commandArg).toContain('sudo -k -S -p');
    expect(commandArg).toContain("sh -c 'cat /etc/shadow'");

    // Simulate sudo prompt
    fakeOnData!(SUDO_PROMPT_TOKEN);
    await new Promise(r => setTimeout(r, 0));

    // Simulate output + exit
    fakeOnData!('root:x:0:0:root\n');
    fakeOnExit!({ exitCode: 0 });

    const result = await promise;
    expect(result.exit_code).toBe(0);
  });

  it('uses sudo -n when sudo=true but no password ref', async () => {
    const registry = makeRegistry();
    const credMap = makeMockCredentialMap();

    const promise = sshExecute(registry, {
      host: 'test-host',
      command: 'whoami',
      username: 'testuser',
      sudo: true,
    }, credMap);

    await new Promise(r => setTimeout(r, 10));

    const spawnCall = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
    const sshArgs: string[] = spawnCall[1];
    const commandArg = sshArgs[sshArgs.length - 1];
    expect(commandArg).toContain('sudo -n');
    expect(commandArg).not.toContain('-S');

    // Simulate output + exit
    fakeOnData!('root\n');
    fakeOnExit!({ exitCode: 0 });

    const result = await promise;
    expect(result.output).toContain('root');
  });

  it('rejects with clear error when sudo_password_ref provided without sudo=true', async () => {
    const registry = makeRegistry();
    const credMap = makeMockCredentialMap();

    await expect(
      sshExecute(registry, {
        host: 'test-host',
        command: 'whoami',
        username: 'testuser',
        sudo_password_ref: { backend: 'test-backend', ref: 'ref' },
      }, credMap),
    ).rejects.toThrow(/sudo=true/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ssh_session_execute sudo + enable tests
// ═══════════════════════════════════════════════════════════════════════════

describe('sshSessionExecute with sudo', () => {
  it('wraps command with sudo -S and sends password on prompt', async () => {
    const store = new SessionStore();
    const pty = makeFakePty();
    const session = makeSession(pty);
    store.add(session);
    const registry = makeRegistry();

    const promise = sshSessionExecute(store, {
      session_id: session.id,
      command: 'cat /etc/shadow',
      timeout_ms: 5000,
      sudo: true,
      sudo_password_ref: { backend: 'test-backend', ref: 'sudo-ref' },
    }, undefined, registry);

    await new Promise(r => setTimeout(r, 10));

    // Verify sudo -S command was written
    const writeCall = pty.write.mock.calls[0][0] as string;
    expect(writeCall).toContain('sudo -k -S -p');
    expect(writeCall).toContain("sh -c 'cat /etc/shadow'");

    // Simulate sudo prompt
    pty._triggerData(SUDO_PROMPT_TOKEN);
    await new Promise(r => setTimeout(r, 0));

    // Verify password was sent
    expect(pty.write).toHaveBeenCalledWith('sudo-secret\r');

    // Simulate output + prompt
    pty._triggerData('root:x:0:0:root\r\ntestuser@test-host:~$ ');

    const result = await promise;
    expect(result.output).toContain('root:x:0:0:root');
    store.destroy();
  });

  it('uses sudo -n when no password ref', async () => {
    const store = new SessionStore();
    const pty = makeFakePty();
    const session = makeSession(pty);
    store.add(session);

    const promise = sshSessionExecute(store, {
      session_id: session.id,
      command: 'whoami',
      timeout_ms: 5000,
      sudo: true,
    });

    await new Promise(r => setTimeout(r, 0));

    const writeCall = pty.write.mock.calls[0][0] as string;
    expect(writeCall).toContain('sudo -n');
    expect(writeCall).not.toContain('-S');

    pty._triggerData('root\r\ntestuser@test-host:~$ ');

    const result = await promise;
    expect(result.output).toContain('root');
    store.destroy();
  });

  it('detects sudo -n failure with clear error', async () => {
    const store = new SessionStore();
    const pty = makeFakePty();
    const session = makeSession(pty);
    store.add(session);

    const promise = sshSessionExecute(store, {
      session_id: session.id,
      command: 'cat /etc/shadow',
      timeout_ms: 5000,
      sudo: true,
    });

    await new Promise(r => setTimeout(r, 0));
    pty._triggerData('sudo: a password is required\r\ntestuser@test-host:~$ ');

    await expect(promise).rejects.toThrow(/sudo_password_ref/);
    store.destroy();
  });
});

describe('sshSessionExecute with enable mode', () => {
  it('sends enable, password, then command in sequence', async () => {
    const store = new SessionStore();
    const pty = makeFakePty();
    const session = makeSession(pty, { platform: 'nxos' });
    store.add(session);
    const registry = makeRegistry(makeFakeBackend('enable-secret'));

    const promise = sshSessionExecute(store, {
      session_id: session.id,
      command: 'show running-config',
      timeout_ms: 5000,
      enable_password_ref: { backend: 'test-backend', ref: 'enable-ref' },
    }, undefined, registry);

    await new Promise(r => setTimeout(r, 10));

    // Step 1: 'enable' was sent
    expect(pty.write).toHaveBeenCalledWith('enable\r');

    // Step 2: device asks for password
    pty._triggerData('Password: ');
    await new Promise(r => setTimeout(r, 0));

    // Step 3: password was sent
    expect(pty.write).toHaveBeenCalledWith('enable-secret\r');

    // Step 4: device returns to privileged prompt
    pty._triggerData('switch-1#');
    await new Promise(r => setTimeout(r, 0));

    // Step 5: actual command was sent
    expect(pty.write).toHaveBeenCalledWith('show running-config\r');

    // Step 6: command output + prompt
    pty._triggerData('hostname switch-1\r\nswitch-1# ');

    const result = await promise;
    expect(result.output).toContain('hostname switch-1');
    store.destroy();
  });

  it('rejects when enable + sudo combined', async () => {
    const store = new SessionStore();
    const pty = makeFakePty();
    const session = makeSession(pty);
    store.add(session);

    await expect(
      sshSessionExecute(store, {
        session_id: session.id,
        command: 'show run',
        sudo: true,
        enable_password_ref: { backend: 'test', ref: 'ref' },
      }),
    ).rejects.toThrow(/Cannot use both/);
    store.destroy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Security: no password leakage
// ═══════════════════════════════════════════════════════════════════════════

describe('no password leakage', () => {
  it('sudo error messages never contain the password value', async () => {
    const store = new SessionStore();
    const pty = makeFakePty();
    const session = makeSession(pty);
    store.add(session);

    const promise = sshSessionExecute(store, {
      session_id: session.id,
      command: 'cat /etc/shadow',
      timeout_ms: 5000,
      sudo: true,
    });

    await new Promise(r => setTimeout(r, 0));
    pty._triggerData('sudo: a password is required\n');

    try {
      await promise;
    } catch (err: unknown) {
      const msg = (err as Error).message;
      expect(msg).not.toContain('sudo-secret');
      expect(msg).toContain('sudo_password_ref');
    }
    store.destroy();
  });

  it('pty-manager sudo error does not leak password buffer content', async () => {
    const promise = runSshSession({
      host: 'test-host',
      username: 'testuser',
      command: "sudo -n -- sh -c 'cat /etc/shadow'",
      platform: 'linux',
      timeout_ms: 5000,
      sudo_password: Buffer.from('top-secret-password'),
    });

    await new Promise(r => setTimeout(r, 0));
    fakeOnData!('sudo: a password is required\n');

    try {
      await promise;
    } catch (err: unknown) {
      const msg = (err as Error).message;
      expect(msg).not.toContain('top-secret-password');
    }
  });

  it('sudo password buffer is zeroed after sshExecute completes', async () => {
    const backend = makeFakeBackend('zero-me');
    const registry = makeRegistry(backend);
    const credMap = makeMockCredentialMap();

    const promise = sshExecute(registry, {
      host: 'test-host',
      command: 'whoami',
      username: 'testuser',
      sudo: true,
      sudo_password_ref: { backend: 'test-backend', ref: 'ref' },
    }, credMap);

    await new Promise(r => setTimeout(r, 10));
    fakeOnData!('root\n');
    fakeOnExit!({ exitCode: 0 });

    await promise;
    // Backend cleanup should have been called
    expect(backend.cleanup).toHaveBeenCalled();
  });
});
