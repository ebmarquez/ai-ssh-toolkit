/**
 * ssh_stream_cancel tool handler — cancels a running streaming SSH command.
 */

import type { StreamStore } from '../ssh/stream-store.js';

export interface SshStreamCancelInput {
  stream_id: string;
}

export function sshStreamCancel(
  streamStore: StreamStore,
  input: SshStreamCancelInput,
): { success: boolean; message: string } {
  const { stream_id } = input;
  if (!stream_id?.trim()) throw new Error('stream_id is required');
  return streamStore.cancel(stream_id);
}
