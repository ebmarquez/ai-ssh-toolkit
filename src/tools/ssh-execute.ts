/**
 * ssh_execute tool handler — runs a command over an interactive SSH PTY session.
 *
 * NOTE: The full PTY session manager (src/ssh/pty-manager.ts) is not yet implemented.
 * This handler returns a clear not-implemented error rather than silently failing.
 */

import type { PlatformHint } from '../ssh/prompt-detector.js';
import type { CredentialRegistry } from '../credentials/registry.js';

export interface SshExecuteInput {
  host: string;
  command: string;
  username?: string;
  credential_ref?: string;
  credential_backend?: string;
  platform?: PlatformHint;
  timeout_ms?: number;
}

export interface SshExecuteResult {
  output: string;
  exit_code: number | null;
}

export async function sshExecute(
  registry: CredentialRegistry,
  input: SshExecuteInput
): Promise<SshExecuteResult> {
  const {
    host,
    command,
    username,
    credential_ref,
    credential_backend,
  } = input;

  // Resolve credentials if a ref is provided
  // TODO(pty): input.platform, input.timeout_ms, and resolvedUsername will be
  // wired into PtyManager when src/ssh/pty-manager.ts is implemented.
  let resolvedUsername = username ?? '';
  if (credential_ref !== undefined) {
    if (!credential_ref.trim()) {
      throw new Error('credential_ref cannot be empty');
    }
    const backendName = credential_backend ?? 'google-secret-manager';
    const backend = registry.getBackend(backendName);
    try {
      const available = await backend.isAvailable();
      if (!available) {
        process.stderr.write(`Credential backend "${backendName}" unavailable in ssh_execute\n`);
        throw new Error(`Credential backend "${backendName}" failed. Check server logs for details.`);
      }
      const cred = await backend.getCredential(credential_ref);
      resolvedUsername = cred.username || resolvedUsername;
      // Zero-fill password buffer after capturing — not used until PTY is wired
      cred.password.fill(0);
    } finally {
      await backend.cleanup();
    }
  }

  // Validate inputs before attempting connection
  if (!host) throw new Error('host is required');
  if (!command) throw new Error('command is required');

  // TODO(pty): wire detectPrompt, detectPasswordPrompt, scrubOutput, resolvedUsername,
  // platform, input.timeout_ms when PtyManager (src/ssh/pty-manager.ts) is implemented.
  void resolvedUsername;

  throw new Error(
    'ssh_execute: PTY session manager (src/ssh/pty-manager.ts) is not yet implemented. ' +
    'The credential lookup and output-scrubbing helpers are wired and ready; ' +
    'implement PtyManager to complete this tool.'
  );
}
