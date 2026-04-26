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
import type { IDisposable } from 'node-pty';
import type { PlatformHint } from './prompt-detector.js';

export interface ManagedSession {
  id: string;           // crypto.randomUUID()
  ptyProcess: IPty;     // node-pty instance
  lastActivity: number; // Date.now()
  host: string;
  username: string;
  platform: PlatformHint;
  outputBuffer: string; // accumulates PTY output since last command
  idleTimeoutMs?: number; // per-session idle timeout override
  inFlight: boolean;      // true while a command is executing
  disposables: IDisposable[]; // active PTY listeners to dispose on cleanup
}

export class SessionStore {
  private sessions = new Map<string, ManagedSession>();
  private cleanupInterval: NodeJS.Timeout;
  private destroyed = false;

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

  /** Remove a session from the store (disposes listeners). Returns true if it existed.
   * If the session is inFlight, listeners are NOT disposed (the in-flight execute
   * owns them and will clean up via cleanup()). The PTY is always killed.
   */
  delete(id: string): boolean {
    const session = this.sessions.get(id);
    if (session) {
      if (!session.inFlight) {
        // Only dispose listeners when no command is executing
        for (const d of session.disposables) {
          try { d.dispose(); } catch { /* ignore */ }
        }
        session.disposables.length = 0;
      }
      // Always kill the PTY process
      try { session.ptyProcess.kill(); } catch { /* ignore */ }
    }
    return this.sessions.delete(id);
  }

  /** Kill and remove sessions that have been idle longer than their timeout. */
  private evictIdle(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      // Never evict a session with a command in flight
      if (session.inFlight) continue;
      const timeout = session.idleTimeoutMs ?? this.idleTimeoutMs;
      if (now - session.lastActivity > timeout) {
        for (const d of session.disposables) {
          try { d.dispose(); } catch { /* ignore */ }
        }
        session.disposables.length = 0;
        try {
          session.ptyProcess.kill();
        } catch {
          // PTY may already be dead — ignore
        }
        this.sessions.delete(id);
      }
    }
  }

  /** Kill all sessions and stop the cleanup interval. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.cleanupInterval);
    for (const session of this.sessions.values()) {
      for (const d of session.disposables) {
        try { d.dispose(); } catch { /* ignore */ }
      }
      session.disposables.length = 0;
      try {
        session.ptyProcess.kill();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
  }
}
