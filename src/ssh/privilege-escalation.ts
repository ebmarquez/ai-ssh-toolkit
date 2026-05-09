/**
 * Privilege escalation helpers for sudo and Cisco enable mode.
 *
 * Provides:
 *   - Sudo password prompt detection (custom deterministic prompt)
 *   - Command wrapping for sudo -S with proper shell quoting
 *   - Enable mode prompt/password sequence handling
 *   - Credential fetching with proper buffer lifecycle
 */

import type { CredentialRegistry } from '../credentials/registry.js';

/** Deterministic sudo prompt token — used with `sudo -S -p` to avoid
 *  confusion with SSH password prompts or localized sudo messages. */
export const SUDO_PROMPT_TOKEN = '__AI_SSH_TOOLKIT_SUDO__:';

/** Credential reference for escalation passwords. */
export interface EscalationCredentialRef {
  backend: string;
  ref: string;
}

/**
 * Fetch an escalation password from a credential backend.
 * Returns a new Buffer that the caller MUST zero-fill after use.
 */
export async function fetchEscalationCredential(
  registry: CredentialRegistry,
  credRef: EscalationCredentialRef,
): Promise<Buffer<ArrayBufferLike>> {
  const backend = registry.getBackend(credRef.backend);
  try {
    const available = await backend.isAvailable();
    if (!available) {
      throw new Error(
        `Credential backend "${credRef.backend}" is not available for privilege escalation.`,
      );
    }
    const cred = await backend.getCredential(credRef.ref);
    // Copy into our own buffer so backend.cleanup() doesn't wipe it
    const buf = Buffer.from(cred.password) as Buffer<ArrayBufferLike>;
    cred.password.fill(0);
    return buf;
  } finally {
    await backend.cleanup();
  }
}

/**
 * Shell-quote a string for use inside single quotes in sh -c.
 * Replaces every ' with '\'' (end quote, escaped quote, start quote).
 */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Build a sudo-wrapped command string for SSH argv.
 *
 * When a password is available: `sudo -k -S -p '<token>' -- sh -c '<cmd>'`
 *   -k  invalidates cached credentials to force our password
 *   -S  reads password from stdin
 *   -p  sets a deterministic prompt we can detect
 *
 * When no password (passwordless): `sudo -n -- sh -c '<cmd>'`
 *   -n  non-interactive, fails immediately if password needed
 */
export function buildSudoCommand(command: string, hasPassword: boolean): string {
  const quoted = shellQuote(command);
  if (hasPassword) {
    return `sudo -k -S -p ${shellQuote(SUDO_PROMPT_TOKEN)} -- sh -c ${quoted}`;
  }
  return `sudo -n -- sh -c ${quoted}`;
}

/**
 * Detect our custom sudo password prompt in PTY output.
 */
export function detectSudoPrompt(output: string): boolean {
  return output.includes(SUDO_PROMPT_TOKEN);
}

/** Pattern indicating sudo -n failure (password required). */
const SUDO_PASSWORD_REQUIRED_RE = /sudo:.*(?:a password is required|interactive password|no tty present)/i;

/**
 * Check if sudo -n output indicates a password is required.
 */
export function isSudoPasswordRequired(output: string): boolean {
  return SUDO_PASSWORD_REQUIRED_RE.test(output);
}

/**
 * Detect Cisco enable password prompt.
 * Enable prompt is typically just "Password:" on its own line,
 * similar to SSH but appears after sending "enable".
 */
export function detectEnablePrompt(output: string): boolean {
  return /[Pp]assword:\s*$/.test(output);
}

/**
 * Validate escalation input combinations and throw clear errors.
 */
export function validateEscalationInputs(opts: {
  sudo?: boolean;
  sudo_password_ref?: EscalationCredentialRef;
  enable_password_ref?: EscalationCredentialRef;
}): void {
  if (opts.sudo && opts.enable_password_ref) {
    throw new Error(
      'Cannot use both sudo and enable_password_ref simultaneously. ' +
      'Use sudo for Linux hosts or enable_password_ref for network devices, not both.',
    );
  }
  if (opts.sudo_password_ref && !opts.sudo) {
    throw new Error(
      'sudo_password_ref requires sudo=true. Set sudo to true to use privilege escalation.',
    );
  }
}
