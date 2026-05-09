/**
 * Host key verification helper — used by ssh_execute and ssh_session_open
 * to enforce TOFU (Trust On First Use) host key pinning before connecting.
 */

import type { HostKeyStore } from '../security/host-key-store.js';
import { scanHostKeys } from '../security/host-key-scanner.js';

/**
 * Verify host key for a connection target.  On first use, pins the key.
 * On mismatch, throws an error that refuses the connection.
 *
 * If scanning fails and no pinned keys exist, the connection proceeds
 * (we cannot TOFU without keys).  If scanning fails but pinned keys
 * exist, the connection is refused (fail-closed).
 */
export async function verifyHostKey(
  store: HostKeyStore,
  host: string,
  port: number = 22,
): Promise<void> {
  let liveFingerprints;
  try {
    liveFingerprints = await scanHostKeys({ host, port, timeoutSeconds: 5 });
  } catch (err) {
    const existing = store.lookup(host, port);
    if (existing) {
      // Fail closed: we have pinned keys but can't verify
      throw new Error(
        `Host key verification failed for ${host}:${port}: unable to scan live keys ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        'Pinned keys exist — refusing connection for safety.',
        { cause: err },
      );
    }
    // No pinned keys and can't scan → skip verification (first-use scenario
    // where keyscan binary is unavailable or host doesn't respond to keyscan)
    return;
  }

  if (liveFingerprints.length === 0) {
    const existing = store.lookup(host, port);
    if (existing) {
      throw new Error(
        `Host key verification failed for ${host}:${port}: ssh-keyscan returned no keys. ` +
        'Pinned keys exist — refusing connection for safety.',
      );
    }
    return;
  }

  const detail = store.verify(host, port, liveFingerprints);

  switch (detail.result) {
    case 'new':
      // TOFU: pin on first use
      store.pin(host, port, liveFingerprints);
      break;
    case 'match':
      // All good
      break;
    case 'mismatch': {
      const expected = detail.expected?.map(f => `${f.type} ${f.sha256}`).join(', ') ?? 'unknown';
      const got = detail.got?.map(f => `${f.type} ${f.sha256}`).join(', ') ?? 'unknown';
      throw new Error(
        `Host key mismatch for ${host}:${port}: expected [${expected}], got [${got}]. ` +
        'Use ssh_host_key_trust to re-pin.',
      );
    }
  }
}
