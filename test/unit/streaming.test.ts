/**
 * Unit tests for poll-based streaming output (StreamStore + tool handlers).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamStore } from '../../src/ssh/stream-store.js';
import { sshStreamRead } from '../../src/tools/ssh-stream-read.js';
import { sshStreamCancel } from '../../src/tools/ssh-stream-cancel.js';
import { sshStreamList } from '../../src/tools/ssh-stream-list.js';

describe('StreamStore', () => {
  let store: StreamStore;

  beforeEach(() => {
    store = new StreamStore();
  });

  afterEach(() => {
    store.destroy();
  });

  it('creates a stream and returns it via get()', () => {
    store.create('s1', 'host1', 'ls -la');
    const entry = store.get('s1');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('running');
    expect(entry!.host).toBe('host1');
    expect(entry!.command).toBe('ls -la');
    expect(entry!.chunks).toHaveLength(0);
  });

  it('appends chunks with timestamps', () => {
    store.create('s1', 'host1', 'cmd');
    store.appendChunk('s1', 'hello ', 'stdout');
    store.appendChunk('s1', 'world', 'stderr');

    const entry = store.get('s1')!;
    expect(entry.chunks).toHaveLength(2);
    expect(entry.chunks[0].text).toBe('hello ');
    expect(entry.chunks[0].channel).toBe('stdout');
    expect(entry.chunks[1].text).toBe('world');
    expect(entry.chunks[1].channel).toBe('stderr');
    // Timestamps should be valid ISO 8601
    expect(() => new Date(entry.chunks[0].timestamp)).not.toThrow();
    expect(entry.totalBytes).toBe(11);
  });

  it('ignores chunks after completion', () => {
    store.create('s1', 'host1', 'cmd');
    store.appendChunk('s1', 'before', 'stdout');
    store.complete('s1', 0);
    store.appendChunk('s1', 'after', 'stdout');

    const entry = store.get('s1')!;
    expect(entry.chunks).toHaveLength(1);
    expect(entry.chunks[0].text).toBe('before');
  });

  it('read returns chunks from offset', () => {
    store.create('s1', 'host1', 'cmd');
    store.appendChunk('s1', 'chunk0', 'stdout');
    store.appendChunk('s1', 'chunk1', 'stdout');
    store.appendChunk('s1', 'chunk2', 'stdout');

    const r1 = store.read('s1', 0);
    expect(r1.chunks).toHaveLength(3);
    expect(r1.offset).toBe(3);
    expect(r1.status).toBe('running');

    const r2 = store.read('s1', 2);
    expect(r2.chunks).toHaveLength(1);
    expect(r2.chunks[0].text).toBe('chunk2');
    expect(r2.offset).toBe(3);
  });

  it('read with offset beyond chunks returns empty', () => {
    store.create('s1', 'host1', 'cmd');
    store.appendChunk('s1', 'data', 'stdout');

    const r = store.read('s1', 10);
    expect(r.chunks).toHaveLength(0);
    expect(r.offset).toBe(1);
  });

  it('read defaults to offset 0', () => {
    store.create('s1', 'host1', 'cmd');
    store.appendChunk('s1', 'data', 'stdout');

    const r = store.read('s1');
    expect(r.chunks).toHaveLength(1);
  });

  it('read throws for unknown stream', () => {
    expect(() => store.read('nonexistent')).toThrow('Stream "nonexistent" not found');
  });

  it('read throws for negative offset', () => {
    store.create('s1', 'host1', 'cmd');
    expect(() => store.read('s1', -1)).toThrow('offset must be non-negative');
  });

  it('complete sets status and exit_code', () => {
    store.create('s1', 'host1', 'cmd');
    store.complete('s1', 42);

    const entry = store.get('s1')!;
    expect(entry.status).toBe('completed');
    expect(entry.exit_code).toBe(42);
    expect(entry.completedAt).toBeDefined();
  });

  it('fail sets status and error', () => {
    store.create('s1', 'host1', 'cmd');
    store.fail('s1', 'timeout');

    const entry = store.get('s1')!;
    expect(entry.status).toBe('failed');
    expect(entry.error).toBe('timeout');
  });

  it('terminal state guards prevent double transitions', () => {
    store.create('s1', 'host1', 'cmd');
    store.complete('s1', 0);
    store.fail('s1', 'should be ignored');

    expect(store.get('s1')!.status).toBe('completed');
    expect(store.get('s1')!.error).toBeUndefined();
  });

  it('cancel sets status to cancelled and invokes onCancel', () => {
    const onCancel = vi.fn();
    store.create('s1', 'host1', 'cmd', onCancel);
    const result = store.cancel('s1');

    expect(result.success).toBe(true);
    expect(store.get('s1')!.status).toBe('cancelled');
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('cancel after completion returns failure', () => {
    store.create('s1', 'host1', 'cmd');
    store.complete('s1', 0);
    const result = store.cancel('s1');

    expect(result.success).toBe(false);
    expect(result.message).toContain('already completed');
  });

  it('cancel for unknown stream returns failure', () => {
    const result = store.cancel('nonexistent');
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('complete after cancel is ignored', () => {
    store.create('s1', 'host1', 'cmd');
    store.cancel('s1');
    store.complete('s1', 0);

    expect(store.get('s1')!.status).toBe('cancelled');
  });

  it('list returns all streams without chunks', () => {
    store.create('s1', 'host1', 'cmd1');
    store.create('s2', 'host2', 'cmd2');
    store.appendChunk('s1', 'data', 'stdout');

    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('s1');
    expect(list[0].chunkCount).toBe(1);
    expect(list[0].totalBytes).toBe(4);
    // list entries should not contain chunks array
    expect((list[0] as Record<string, unknown>).chunks).toBeUndefined();
  });

  it('destroy clears all streams and cancels running ones', () => {
    const onCancel = vi.fn();
    store.create('s1', 'host1', 'cmd', onCancel);
    store.create('s2', 'host2', 'cmd2');
    store.complete('s2', 0);

    store.destroy();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(store.list()).toHaveLength(0);
  });

  it('auto-cleanup removes completed streams after delay', async () => {
    vi.useFakeTimers();
    try {
      store.create('s1', 'host1', 'cmd');
      store.complete('s1', 0);
      expect(store.get('s1')).toBeDefined();

      // Advance past cleanup delay (5 minutes)
      vi.advanceTimersByTime(5 * 60 * 1000 + 100);

      expect(store.get('s1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sshStreamRead', () => {
  it('returns chunks and status from StreamStore', () => {
    const store = new StreamStore();
    store.create('s1', 'host1', 'cmd');
    store.appendChunk('s1', 'hello', 'stdout');

    const result = sshStreamRead(store, { stream_id: 's1' });
    expect(result.chunks).toHaveLength(1);
    expect(result.status).toBe('running');
    expect(result.offset).toBe(1);

    store.destroy();
  });

  it('supports offset-based polling', () => {
    const store = new StreamStore();
    store.create('s1', 'host1', 'cmd');
    store.appendChunk('s1', 'line1', 'stdout');
    store.appendChunk('s1', 'line2', 'stdout');

    const r1 = sshStreamRead(store, { stream_id: 's1', offset: 0 });
    expect(r1.chunks).toHaveLength(2);

    store.appendChunk('s1', 'line3', 'stdout');
    const r2 = sshStreamRead(store, { stream_id: 's1', offset: r1.offset });
    expect(r2.chunks).toHaveLength(1);
    expect(r2.chunks[0].text).toBe('line3');

    store.destroy();
  });

  it('includes exit_code when completed', () => {
    const store = new StreamStore();
    store.create('s1', 'host1', 'cmd');
    store.complete('s1', 0);

    const result = sshStreamRead(store, { stream_id: 's1' });
    expect(result.status).toBe('completed');
    expect(result.exit_code).toBe(0);

    store.destroy();
  });

  it('throws for empty stream_id', () => {
    const store = new StreamStore();
    expect(() => sshStreamRead(store, { stream_id: '' })).toThrow('stream_id is required');
    store.destroy();
  });
});

describe('sshStreamCancel', () => {
  it('cancels a running stream', () => {
    const store = new StreamStore();
    const onCancel = vi.fn();
    store.create('s1', 'host1', 'cmd', onCancel);

    const result = sshStreamCancel(store, { stream_id: 's1' });
    expect(result.success).toBe(true);
    expect(onCancel).toHaveBeenCalled();

    store.destroy();
  });

  it('throws for empty stream_id', () => {
    const store = new StreamStore();
    expect(() => sshStreamCancel(store, { stream_id: '  ' })).toThrow('stream_id is required');
    store.destroy();
  });
});

describe('sshStreamList', () => {
  it('returns summary of all streams', () => {
    const store = new StreamStore();
    store.create('s1', 'host1', 'cmd1');
    store.create('s2', 'host2', 'cmd2');

    const list = sshStreamList(store);
    expect(list).toHaveLength(2);
    expect(list.map(e => e.id)).toContain('s1');
    expect(list.map(e => e.id)).toContain('s2');

    store.destroy();
  });

  it('returns empty list when no streams', () => {
    const store = new StreamStore();
    expect(sshStreamList(store)).toHaveLength(0);
    store.destroy();
  });
});
