/**
 * SSH host key scanning utility — wraps ssh-keyscan + ssh-keygen to retrieve
 * host key fingerprints without authentication.
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { resolveCliPath } from '../utils/cli-resolver.js';
import type { StoredFingerprint } from '../security/host-key-store.js';

const execFileAsync = promisify(execFile);

/** Raw key line from ssh-keyscan output (one per algorithm). */
interface KeyScanLine {
  host: string;
  type: string;
  public_key: string;
}

/**
 * Parse ssh-keyscan stdout into structured key lines.
 * Each non-comment line looks like: `hostname ssh-ed25519 AAAAC3Nza...`
 */
export function parseKeyscanOutput(stdout: string): KeyScanLine[] {
  const lines: KeyScanLine[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 3) {
      lines.push({ host: parts[0], type: parts[1], public_key: parts[2] });
    }
  }
  return lines;
}

/**
 * Compute SHA-256 fingerprint of a single key line using ssh-keygen.
 * Input is a full ssh-keyscan line: `host type base64key`
 */
async function fingerprintKeyLine(
  sshKeygenBin: string,
  keyLine: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(sshKeygenBin, ['-lf', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });

    let stdout = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      if (code !== 0) { resolve(null); return; }
      // Output: "256 SHA256:abc... host (ED25519)"
      const match = stdout.match(/SHA256:\S+/);
      resolve(match ? match[0] : null);
    });

    proc.stdin.write(keyLine + '\n');
    proc.stdin.end();
  });
}

export interface ScanHostKeysOptions {
  host: string;
  port?: number;
  timeoutSeconds?: number;
}

/**
 * Scan a remote host for SSH host keys and return fingerprints.
 * Does NOT require authentication — uses ssh-keyscan.
 */
export async function scanHostKeys(
  opts: ScanHostKeysOptions,
): Promise<StoredFingerprint[]> {
  const { host, port = 22, timeoutSeconds = 5 } = opts;

  const sshKeyscanBin = resolveCliPath('ssh-keyscan');
  const sshKeygenBin = resolveCliPath('ssh-keygen');

  const args = [
    '-T', String(timeoutSeconds),
    '-p', String(port),
    '-t', 'ed25519,rsa,ecdsa',
    '--',
    host,
  ];

  const { stdout } = await execFileAsync(sshKeyscanBin, args, {
    timeout: (timeoutSeconds + 2) * 1000,
  });

  const keyLines = parseKeyscanOutput(stdout);
  const fingerprints: StoredFingerprint[] = [];

  for (const kl of keyLines) {
    const fullLine = `${kl.host} ${kl.type} ${kl.public_key}`;
    const sha256 = await fingerprintKeyLine(sshKeygenBin, fullLine);
    if (sha256) {
      fingerprints.push({
        type: kl.type,
        sha256,
        public_key: kl.public_key,
      });
    }
  }

  return fingerprints;
}

/**
 * Detect OS family from an SSH banner string.
 */
export function detectOsHint(banner: string | undefined): string | null {
  if (!banner) return null;
  const lower = banner.toLowerCase();

  if (lower.includes('ubuntu')) return 'Ubuntu';
  if (lower.includes('debian')) return 'Debian';
  if (lower.includes('redhat') || lower.includes('red hat')) return 'RedHat';
  if (lower.includes('centos')) return 'CentOS';
  if (lower.includes('fedora')) return 'Fedora';
  if (lower.includes('freebsd')) return 'FreeBSD';
  if (lower.includes('openbsd')) return 'OpenBSD';
  if (lower.includes('windows')) return 'Windows';
  if (lower.includes('cisco')) return 'Cisco';
  if (lower.includes('junos')) return 'Juniper';
  if (lower.includes('sonic')) return 'SONiC';
  if (lower.includes('cumulus')) return 'Cumulus';
  if (lower.includes('arista')) return 'Arista';
  if (lower.includes('openssh')) return 'Linux/Unix';
  if (lower.includes('dropbear')) return 'Embedded/Linux';

  return null;
}
