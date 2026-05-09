/**
 * ssh_stream_list tool handler — lists active and recent streams.
 */

import type { StreamStore, StreamListEntry } from '../ssh/stream-store.js';

export function sshStreamList(
  streamStore: StreamStore,
): StreamListEntry[] {
  return streamStore.list();
}
