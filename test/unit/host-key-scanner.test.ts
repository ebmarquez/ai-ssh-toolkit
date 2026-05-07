import { describe, expect, it } from 'vitest';
import { parseKeyscanOutput, detectOsHint } from '../../src/security/host-key-scanner.js';

// ── parseKeyscanOutput ──────────────────────────────────────────────────────

describe('parseKeyscanOutput', () => {
  it('parses typical ssh-keyscan output', () => {
    const stdout = [
      '# example.com:22 SSH-2.0-OpenSSH_8.9',
      'example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKey1',
      'example.com ssh-rsa AAAAB3NzaC1yc2EAAAAFakeKey2',
      '',
    ].join('\n');

    const lines = parseKeyscanOutput(stdout);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      host: 'example.com',
      type: 'ssh-ed25519',
      public_key: 'AAAAC3NzaC1lZDI1NTE5AAAAIFakeKey1',
    });
    expect(lines[1]).toEqual({
      host: 'example.com',
      type: 'ssh-rsa',
      public_key: 'AAAAB3NzaC1yc2EAAAAFakeKey2',
    });
  });

  it('skips comment lines', () => {
    const stdout = '# comment\n# another comment\n';
    expect(parseKeyscanOutput(stdout)).toHaveLength(0);
  });

  it('handles empty output', () => {
    expect(parseKeyscanOutput('')).toHaveLength(0);
  });

  it('handles bracket-notation hosts', () => {
    const stdout = '[example.com]:2222 ssh-ed25519 AAAAC3NzKey\n';
    const lines = parseKeyscanOutput(stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0].host).toBe('[example.com]:2222');
  });
});

// ── detectOsHint ────────────────────────────────────────────────────────────

describe('detectOsHint', () => {
  it('detects Ubuntu', () => {
    expect(detectOsHint('SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.6')).toBe('Ubuntu');
  });

  it('detects Debian', () => {
    expect(detectOsHint('SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u3')).toBe('Debian');
  });

  it('detects generic OpenSSH as Linux/Unix', () => {
    expect(detectOsHint('SSH-2.0-OpenSSH_9.6')).toBe('Linux/Unix');
  });

  it('detects Cisco', () => {
    expect(detectOsHint('SSH-2.0-Cisco-1.25')).toBe('Cisco');
  });

  it('detects Dropbear as Embedded/Linux', () => {
    expect(detectOsHint('SSH-2.0-dropbear_2020.81')).toBe('Embedded/Linux');
  });

  it('returns null for undefined', () => {
    expect(detectOsHint(undefined)).toBeNull();
  });

  it('returns null for unrecognized banner', () => {
    expect(detectOsHint('SSH-2.0-libssh_0.9.6')).toBeNull();
  });

  it('is case insensitive', () => {
    expect(detectOsHint('SSH-2.0-OPENSSH_9.0 UBUNTU')).toBe('Ubuntu');
  });
});
