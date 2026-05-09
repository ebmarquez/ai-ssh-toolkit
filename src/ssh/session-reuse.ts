/**
 * SessionReuseManager — tracks SSH connection activity and provides
 * ControlMaster SSH arguments for transparent connection reuse.
 *
 * When enabled, SSH connections to the same (host, username) tuple are
 * multiplexed over a single TCP connection via OpenSSH ControlMaster.
 *
 * Configuration:
 *   AI_SSH_SESSION_REUSE_TTL_SECONDS — TTL in seconds (default: 60, 0 to disable)
 */

import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Read the session-reuse TTL from the environment.
 * Returns 60 (seconds) by default, 0 means disabled.
 */
export function getSessionReuseTtl(): number {
  const envVal = process.env.AI_SSH_SESSION_REUSE_TTL_SECONDS;
  if (envVal !== undefined) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 60;
}

export class SessionReuseManager {
  private activity = new Map<string, number>();

  constructor(private ttlSeconds: number = 60) {}

  private makeKey(host: string, username: string): string {
    return `${username}@${host}`;
  }

  /** Whether session reuse is enabled (TTL > 0). */
  isEnabled(): boolean {
    return this.ttlSeconds > 0;
  }

  /**
   * Check whether a reusable session exists for this (host, username) combo
   * that is still within the TTL window.
   */
  shouldReuse(host: string, username: string): boolean {
    if (!this.isEnabled()) return false;
    const key = this.makeKey(host, username);
    const lastActivity = this.activity.get(key);
    if (lastActivity === undefined) return false;
    return (Date.now() - lastActivity) < this.ttlSeconds * 1000;
  }

  /** Record a successful connection for TTL tracking. */
  recordActivity(host: string, username: string): void {
    const key = this.makeKey(host, username);
    this.activity.set(key, Date.now());
  }

  /**
   * Return the ControlPath directory, creating it if needed.
   * Uses os.tmpdir()/ai-ssh-toolkit with mode 0o700.
   */
  getControlDir(): string {
    const dir = path.join(os.tmpdir(), 'ai-ssh-toolkit');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * Return extra SSH args for ControlMaster multiplexing.
   * SSH expands %h (host), %p (port), %r (remote user) in ControlPath.
   */
  getControlMasterArgs(): string[] {
    if (!this.isEnabled()) return [];
    const controlPath = path.join(this.getControlDir(), 'cm-%h-%p-%r');
    return [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${controlPath}`,
      '-o', `ControlPersist=${this.ttlSeconds}`,
    ];
  }

  /** Clear all tracked activity (for testing). */
  clear(): void {
    this.activity.clear();
  }
}
