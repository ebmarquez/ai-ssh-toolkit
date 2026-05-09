/**
 * Host key pin store — persists SSH host key fingerprints to
 * ~/.ai-ssh-toolkit/known-keys.json for TOFU (Trust On First Use) pinning.
 *
 * On first connection the host keys are recorded.  On subsequent connections
 * they are compared and a mismatch causes the connection to be refused.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';

// ── Public types ────────────────────────────────────────────────────────────

export interface StoredFingerprint {
  type: string;       // e.g. "ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256"
  sha256: string;     // e.g. "SHA256:abc..."
  public_key?: string; // base64-encoded raw key (allows known_hosts reconstruction)
}

export interface StoredHostEntry {
  fingerprints: StoredFingerprint[];
  first_seen: string;  // ISO-8601
  last_seen: string;   // ISO-8601
}

export type VerifyResult = 'new' | 'match' | 'mismatch';

export interface VerifyDetail {
  result: VerifyResult;
  expected?: StoredFingerprint[];
  got?: StoredFingerprint[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a canonical store key in OpenSSH bracket notation. */
export function hostKey(host: string, port: number = 22): string {
  if (port === 22) return host;
  return `[${host}]:${port}`;
}

// ── HostKeyStore ────────────────────────────────────────────────────────────

export class HostKeyStore {
  private data: Record<string, StoredHostEntry> = {};
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(homedir(), '.ai-ssh-toolkit', 'known-keys.json');
    this.load();
  }

  /** (Re-)load from disk.  Missing / corrupt file → empty store. */
  load(): void {
    if (!existsSync(this.filePath)) {
      this.data = {};
      return;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        this.data = parsed as Record<string, StoredHostEntry>;
      } else {
        this.data = {};
      }
    } catch {
      this.data = {};
    }
  }

  /** Atomically persist the store to disk. */
  save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tmp = this.filePath + '.' + randomBytes(6).toString('hex') + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
    renameSync(tmp, this.filePath);
  }

  /** Pin fingerprints for a host (overwrites any existing entry). */
  pin(host: string, port: number, fingerprints: StoredFingerprint[]): void {
    const key = hostKey(host, port);
    const now = new Date().toISOString();
    const existing = this.data[key];
    this.data[key] = {
      fingerprints,
      first_seen: existing?.first_seen ?? now,
      last_seen: now,
    };
    this.save();
  }

  /** Look up stored entry for a host. */
  lookup(host: string, port: number = 22): StoredHostEntry | undefined {
    return this.data[hostKey(host, port)];
  }

  /** Verify live fingerprints against stored pins. */
  verify(host: string, port: number, liveFingerprints: StoredFingerprint[]): VerifyDetail {
    const entry = this.lookup(host, port);
    if (!entry) {
      return { result: 'new', got: liveFingerprints };
    }

    // Build sets of sha256 values for comparison.
    // A match requires at least one overlapping key type+fingerprint.
    const storedSet = new Set(entry.fingerprints.map(f => `${f.type}:${f.sha256}`));
    const liveSet = new Set(liveFingerprints.map(f => `${f.type}:${f.sha256}`));

    // Check if any live fingerprint matches a stored one
    for (const fp of liveSet) {
      if (storedSet.has(fp)) {
        // Update last_seen
        const key = hostKey(host, port);
        this.data[key].last_seen = new Date().toISOString();
        this.save();
        return { result: 'match', expected: entry.fingerprints, got: liveFingerprints };
      }
    }

    return {
      result: 'mismatch',
      expected: entry.fingerprints,
      got: liveFingerprints,
    };
  }

  /** Remove a host from the store. */
  remove(host: string, port: number = 22): boolean {
    const key = hostKey(host, port);
    if (this.data[key]) {
      delete this.data[key];
      this.save();
      return true;
    }
    return false;
  }

  /** List all pinned hosts. */
  list(): Record<string, StoredHostEntry> {
    return { ...this.data };
  }

  /** Return the file path for diagnostics. */
  getFilePath(): string {
    return this.filePath;
  }
}
