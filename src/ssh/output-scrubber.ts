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

  // Remove credential prompt lines (anchored to prompt-like line starts to avoid
  // stripping normal command output that happens to contain words like "Token Ring:".)
  scrubbed = scrubbed.replace(
    /^\s*(?:enter\s+)?(?:password|secret|passphrase|pass phrase|pin|token|authentication\s+token)\s*:\s*.*(?:\r?\n|$)/gim,
    "",
  );

  // Remove ANSI escape sequences (CSI sequences: ESC [ ... final-byte),
  // including DEC private mode sequences (e.g. bracketed-paste ESC[?2004h/l)
  // eslint-disable-next-line no-control-regex
  scrubbed = scrubbed.replace(/\x1B\[[?!>]?[0-9;]*[A-Za-z]/g, "");

  // Remove OSC sequences (ESC ] ... ST or BEL)
  // eslint-disable-next-line no-control-regex
  scrubbed = scrubbed.replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "");

  // Remove DCS sequences (ESC P ... ST)
  // eslint-disable-next-line no-control-regex
  scrubbed = scrubbed.replace(/\x1BP[\s\S]*?\x1B\\/g, "");

  return scrubbed;
}
