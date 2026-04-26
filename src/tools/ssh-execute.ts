/**
 * ssh_execute tool handler — runs a command over an interactive SSH PTY session.
 */

import type { PlatformHint } from '../ssh/prompt-detector.js';
import type { CredentialRegistry } from '../credentials/registry.js';
import { runSshSession } from '../ssh/pty-manager.js';
import { parseOutput, type ParserPlatform } from '../parsers/index.js';

export interface SshExecuteInput {
  host: string;
  command: string;
  username?: string;
  credential_ref?: string;
  credential_backend?: string;
  platform?: PlatformHint;
  timeout_ms?: number;
  parse_output?: boolean;
  platform_hint?: ParserPlatform;
}

export interface SshExecuteResult {
  output: string;
  exit_code: number | null;
  structured_output?: unknown;
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
    platform = 'auto',
    timeout_ms = 30000,
    parse_output: shouldParse = false,
    platform_hint = 'auto',
  } = input;

  // Validate required inputs
  if (!host) throw new Error('host is required');
  if (!command) throw new Error('command is required');

  // Resolve credentials
  let resolvedUsername = username ?? '';
  // node Buffer — use ArrayBufferLike to satisfy TS6 strict generic check
  let passwordBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

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
      // Copy into our own buffer so backend.cleanup() zeroing stagedBuffers
      // doesn't wipe our copy before we send it to the PTY session.
      passwordBuffer = Buffer.from(cred.password) as Buffer<ArrayBufferLike>;
      // Zero the original credential buffer immediately after copying — don't
      // rely on backend.cleanup() which may be a no-op (e.g. GoogleSecretManager).
      cred.password.fill(0);
    } finally {
      // cleanup() zeros the backend's staged copy (not our local copy above)
      await backend.cleanup();
    }
  }

  if (!resolvedUsername) throw new Error('username is required (provide username or a credential_ref with a username)');

  // Run the PTY session
  try {
    const rawResult = await runSshSession({
      host,
      username: resolvedUsername,
      password: passwordBuffer,
      command,
      platform,
      timeout_ms,
    });

    if (shouldParse) {
      const structured = parseOutput(command, rawResult.output, platform_hint);
      if (structured !== null) {
        return { ...rawResult, structured_output: structured };
      }
    }

    return rawResult;
  } finally {
    // Zero-fill password buffer after PTY session completes (success or failure)
    passwordBuffer.fill(0);
  }
}
