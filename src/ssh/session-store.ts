/**
 * SessionStore — in-memory registry for persistent interactive SSH sessions.
 *
 * Each session holds a live node-pty process. Sessions are evicted
 * automatically after `idleTimeoutMs` milliseconds of inactivity.
 *
 * Security: session IDs are crypto.randomUUID() values and are NEVER
 * logged or included in error messages.
 */

import type { IPty } from 'node-pty';
import type { PlatformHint } from './prompt-detector.js';

export interface ManagedSession {
  id: string;           // crypto.randomUUID()
  ptyProcess: IPty;     // node-pty instance
  lastActivity: number; // Date.now()
  host: string;
  username: string;
  platform: PlatformHint;
  outputBuffer: string; // accumulates PTY output since last command
}

export class SessionStore {
  private sessions = new Map<string, ManagedSession>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(private idleTimeoutMs = 5 * 60 * 1000) {
    // Run cleanup every 60 s to evict idle sessions.
    // .unref() prevents this timer from keeping the process alive.
    this.cleanupInterval = setInterval(() => this.evictIdle(), 60_000).unref();
  }

  /** Add a new session to the store. */
  add(session: ManagedSession): void {
    this.sessions.set(session.id, session);
  }

  /** Retrieve a session by ID. Returns undefined if not found. */
  get(id: string): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  /** Remove a session from the store. Returns true if it existed. */
  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  /** Kill and remove sessions that have been idle longer than idleTimeoutMs. */
  private evictIdle(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > this.idleTimeoutMs) {
        try {
          session.ptyProcess.kill();
        } catch {
          // PTY may already be dead — ignore
        }
        this.sessions.delete(id);
      }
    }
  }

  /** Kill all sessions and stop the cleanup interval. */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    for (const session of this.sessions.values()) {
      try {
        session.ptyProcess.kill();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
  }
}
