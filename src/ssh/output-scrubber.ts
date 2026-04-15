/**
 * Scrub sensitive patterns from PTY output before returning to MCP client.
 */
export function scrubOutput(raw: string): string {
  let scrubbed = raw;

  // Remove password prompt lines that might echo
  scrubbed = scrubbed.replace(/[Pp]assword:\s*.*\r?\n?/g, "");

  // Remove ANSI escape sequences
  // eslint-disable-next-line no-control-regex
  scrubbed = scrubbed.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");

  return scrubbed;
}
