/**
 * ssh_stream_read tool handler — reads output chunks from a streaming SSH command.
 */

import type { StreamStore, StreamReadResult } from '../ssh/stream-store.js';

export interface SshStreamReadInput {
  stream_id: string;
  offset?: number;
}

export function sshStreamRead(
  streamStore: StreamStore,
  input: SshStreamReadInput,
): StreamReadResult {
  const { stream_id, offset } = input;
  if (!stream_id?.trim()) throw new Error('stream_id is required');
  return streamStore.read(stream_id, offset);
}
