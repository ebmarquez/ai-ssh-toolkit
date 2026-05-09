/**
 * StreamStore — manages poll-based streaming output for long-running SSH commands.
 *
 * Each stream accumulates output chunks in memory, keyed by a unique stream_id.
 * Completed/failed/cancelled streams are auto-cleaned after 5 minutes.
 */

import { scrubOutput } from './output-scrubber.js';

export type StreamStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface StreamChunk {
  timestamp: string; // ISO 8601
  text: string;
  channel: 'stdout' | 'stderr';
}

export interface StreamEntry {
  id: string;
  host: string;
  command: string;
  status: StreamStatus;
  chunks: StreamChunk[];
  totalBytes: number;
  exit_code?: number | null;
  error?: string;
  startedAt: string;
  completedAt?: string;
  /** Callback to cancel the underlying process */
  onCancel?: () => void;
}

export interface StreamReadResult {
  chunks: StreamChunk[];
  offset: number;
  status: StreamStatus;
  exit_code?: number | null;
  error?: string;
}

export interface StreamListEntry {
  id: string;
  host: string;
  command: string;
  status: StreamStatus;
  chunkCount: number;
  totalBytes: number;
  startedAt: string;
  completedAt?: string;
  exit_code?: number | null;
  error?: string;
}

/** Max bytes per stream before truncation (10 MB) */
const MAX_STREAM_BYTES = 10 * 1024 * 1024;
/** Auto-cleanup delay after terminal state (5 minutes) */
const CLEANUP_DELAY_MS = 5 * 60 * 1000;

export class StreamStore {
  private streams = new Map<string, StreamEntry>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  create(id: string, host: string, command: string, onCancel?: () => void): void {
    this.streams.set(id, {
      id,
      host,
      command,
      status: 'running',
      chunks: [],
      totalBytes: 0,
      startedAt: new Date().toISOString(),
      onCancel,
    });
  }

  appendChunk(id: string, text: string, channel: 'stdout' | 'stderr'): void {
    const entry = this.streams.get(id);
    if (!entry || entry.status !== 'running') return;

    if (entry.totalBytes >= MAX_STREAM_BYTES) return; // drop data beyond limit

    // Truncate chunk if it would exceed the cap
    const remaining = MAX_STREAM_BYTES - entry.totalBytes;
    const truncated = text.length > remaining ? text.slice(0, remaining) : text;

    entry.chunks.push({
      timestamp: new Date().toISOString(),
      text: scrubOutput(truncated),
      channel,
    });
    entry.totalBytes += truncated.length;
  }

  read(id: string, offset?: number): StreamReadResult {
    const entry = this.streams.get(id);
    if (!entry) throw new Error(`Stream "${id}" not found`);

    const start = offset ?? 0;
    if (start < 0) throw new Error('offset must be non-negative');

    const chunks = entry.chunks.slice(start);
    return {
      chunks,
      offset: entry.chunks.length,
      status: entry.status,
      exit_code: entry.exit_code,
      error: entry.error,
    };
  }

  complete(id: string, exitCode: number | null): void {
    const entry = this.streams.get(id);
    if (!entry || entry.status !== 'running') return; // ignore if already terminal
    entry.status = 'completed';
    entry.exit_code = exitCode;
    entry.completedAt = new Date().toISOString();
    this.scheduleCleanup(id);
  }

  fail(id: string, error?: string): void {
    const entry = this.streams.get(id);
    if (!entry || entry.status !== 'running') return;
    entry.status = 'failed';
    entry.error = error;
    entry.completedAt = new Date().toISOString();
    this.scheduleCleanup(id);
  }

  cancel(id: string): { success: boolean; message: string } {
    const entry = this.streams.get(id);
    if (!entry) return { success: false, message: `Stream "${id}" not found` };
    if (entry.status !== 'running') {
      return { success: false, message: `Stream already ${entry.status}` };
    }
    entry.status = 'cancelled';
    entry.completedAt = new Date().toISOString();
    try {
      entry.onCancel?.();
    } catch { /* best effort */ }
    this.scheduleCleanup(id);
    return { success: true, message: 'Stream cancelled' };
  }

  list(): StreamListEntry[] {
    return [...this.streams.values()].map((e) => ({
      id: e.id,
      host: e.host,
      command: e.command,
      status: e.status,
      chunkCount: e.chunks.length,
      totalBytes: e.totalBytes,
      startedAt: e.startedAt,
      completedAt: e.completedAt,
      exit_code: e.exit_code,
      error: e.error,
    }));
  }

  get(id: string): StreamEntry | undefined {
    return this.streams.get(id);
  }

  destroy(): void {
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer);
    this.cleanupTimers.clear();
    // Cancel all running streams
    for (const entry of this.streams.values()) {
      if (entry.status === 'running') {
        try { entry.onCancel?.(); } catch { /* ignore */ }
      }
    }
    this.streams.clear();
  }

  private scheduleCleanup(id: string): void {
    const timer = setTimeout(() => {
      this.streams.delete(id);
      this.cleanupTimers.delete(id);
    }, CLEANUP_DELAY_MS);
    timer.unref();
    this.cleanupTimers.set(id, timer);
  }
}
