/**
 * Shared PTY spawn options for all SSH sessions.
 *
 * Centralised here so both pty-manager and ssh-multi-execute stay in sync
 * when defaults change.
 */

export const SSH_PTY_OPTIONS = {
  name: 'xterm-color',
  cols: 220,
  // rows: 0 is a compatibility tactic that often reduces or disables
  // paging on some SSH servers and network devices. On certain CLIs
  // (for example, some Cisco-style devices), this can behave similarly
  // to commands such as 'terminal length 0', helping return output
  // without --More-- interruptions.
  rows: 0,
} as const;
