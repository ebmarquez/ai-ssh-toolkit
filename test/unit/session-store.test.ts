/**
 * Unit tests for SessionStore
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IPty } from 'node-pty';
import type { ManagedSession } from '../../src/ssh/session-store.js';
import { SessionStore } from '../../src/ssh/session-store.js';

function makeFakePty(): IPty {
  return {
    kill: vi.fn(),
    write: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    pid: 1,
    cols: 80,
    rows: 24,
    process: 'ssh',
    handleFlowControl: false,
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  } as unknown as IPty;
}

function makeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: crypto.randomUUID(),
    ptyProcess: makeFakePty(),
    lastActivity: Date.now(),
    host: 'test-host',
    username: 'testuser',
    platform: 'linux',
    outputBuffer: '',
    ...overrides,
  };
}

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(5 * 60 * 1000);
  });

  afterEach(() => {
    store.destroy();
  });

  describe('add / get / delete', () => {
    it('adds and retrieves a session', () => {
      const session = makeSession();
      store.add(session);
      expect(store.get(session.id)).toBe(session);
    });

    it('returns undefined for unknown session id', () => {
      expect(store.get(crypto.randomUUID())).toBeUndefined();
    });

    it('deletes a session and returns true', () => {
      const session = makeSession();
      store.add(session);
      expect(store.delete(session.id)).toBe(true);
      expect(store.get(session.id)).toBeUndefined();
    });

    it('returns false when deleting unknown session', () => {
      expect(store.delete(crypto.randomUUID())).toBe(false);
    });
  });

  describe('evictIdle', () => {
    it('evicts sessions that have been idle past the timeout', async () => {
      // Use a very short timeout store for eviction testing
      const fastStore = new SessionStore(100); // 100ms idle timeout
      const session = makeSession({ lastActivity: Date.now() - 200 }); // already stale
      fastStore.add(session);

      // Access private method via bracket notation for testing
      (fastStore as unknown as { evictIdle: () => void }).evictIdle();

      expect(fastStore.get(session.id)).toBeUndefined();
      expect(session.ptyProcess.kill).toHaveBeenCalled();
      fastStore.destroy();
    });

    it('keeps sessions that are still within the timeout window', () => {
      const session = makeSession({ lastActivity: Date.now() }); // fresh
      store.add(session);

      (store as unknown as { evictIdle: () => void }).evictIdle();

      expect(store.get(session.id)).toBe(session);
    });
  });

  describe('destroy', () => {
    it('kills all sessions and clears the store', () => {
      const s1 = makeSession();
      const s2 = makeSession();
      store.add(s1);
      store.add(s2);

      store.destroy();

      expect(s1.ptyProcess.kill).toHaveBeenCalled();
      expect(s2.ptyProcess.kill).toHaveBeenCalled();
      expect(store.get(s1.id)).toBeUndefined();
      expect(store.get(s2.id)).toBeUndefined();
    });
  });
});
