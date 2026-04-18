/**
 * Scrub sensitive patterns from PTY output before returning to MCP client.
 *
 * Covers common credential prompt variants across platforms:
 * - Linux/Unix: Password:, password:
 * - Cisco IOS/NX-OS: Password:, Secret:
 * - SSH keys: Enter passphrase:
 * - Generic: PIN:, Token:, Authentication token:
 */
export function scrubOutput(raw: string): string {
  let scrubbed = raw;

  // Remove credential prompt lines (case-insensitive, multiple variants)
  scrubbed = scrubbed.replace(/(?:password|secret|passphrase|pass phrase|pin|token|auth(?:entication)?(?:\s+token)?)[^:]*:\s*.*\r?\n?/gi, "");

  // Remove ANSI escape sequences (CSI sequences: ESC [ ... final-byte)
  // eslint-disable-next-line no-control-regex
  scrubbed = scrubbed.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");

  // Remove OSC sequences (ESC ] ... ST or BEL)
  // eslint-disable-next-line no-control-regex
  scrubbed = scrubbed.replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "");

  // Remove DCS sequences (ESC P ... ST)
  // eslint-disable-next-line no-control-regex
  scrubbed = scrubbed.replace(/\x1BP[^\x1B]*\x1B\\/g, "");

  return scrubbed;
}
