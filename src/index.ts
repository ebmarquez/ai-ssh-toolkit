#!/usr/bin/env node
/**
 * ai-ssh-toolkit MCP server entry point.
 *
 * Creates an McpServer with StdioServerTransport, registers all 4 tools,
 * and connects to the MCP client via stdin/stdout.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v3';

import { sshExecute } from './tools/ssh-execute.js';
import { credentialGet } from './tools/credential-get.js';
import { credentialListBackends } from './tools/credential-list.js';
import { sshCheckHost } from './tools/ssh-check.js';
import { CredentialRegistry } from './credentials/registry.js';
import { GoogleSecretManagerBackend } from './credentials/google-secret-manager.js';

const server = new McpServer(
  { name: 'ai-ssh-toolkit', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

const credentialRegistry = new CredentialRegistry();
credentialRegistry.register(new GoogleSecretManagerBackend());

// ── ssh_execute ──────────────────────────────────────────────────────────────
server.tool(
  'ssh_execute',
  'Execute a command on a remote host via an interactive SSH PTY session.',
  {
    host: z.string().describe('Hostname or IP address of the remote target'),
    command: z.string().describe('Command to execute on the remote host'),
    username: z.string().optional().describe('SSH username (overrides credential ref username)'),
    credential_ref: z.string().optional().describe('Credential reference string understood by the selected backend'),
    credential_backend: z.string().optional().describe('Name of the credential backend (default: google-secret-manager)'),
    platform: z
      .enum(['nxos', 'os10', 'sonic', 'linux', 'auto'])
      .optional()
      .describe('Platform hint for prompt detection (default: auto)'),
    timeout_ms: z.number().int().positive().optional().describe('Connection + command timeout in milliseconds (default: 30000)'),
  },
  async (input) => {
    try {
      const result = await sshExecute(credentialRegistry, input);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── credential_get ───────────────────────────────────────────────────────────
server.tool(
  'credential_get',
  'Retrieve credential metadata (username, availability) for a given ref. Never returns passwords.',
  {
    ref: z.string().describe('Credential reference string (e.g. "project-id/secret-name")'),
    backend: z.string().optional().describe('Credential backend to use (default: google-secret-manager)'),
  },
  async (input) => {
    try {
      const metadata = await credentialGet(credentialRegistry, input);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(metadata) }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── credential_list_backends ─────────────────────────────────────────────────
server.tool(
  'credential_list_backends',
  'List all registered credential backends and their availability in the current environment.',
  {},
  async () => {
    try {
      const backends = await credentialListBackends(credentialRegistry);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(backends) }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── ssh_check_host ───────────────────────────────────────────────────────────
server.tool(
  'ssh_check_host',
  'Verify SSH connectivity to a host without executing commands.',
  {
    host: z.string().describe('Hostname or IP address to check'),
    port: z.number().int().positive().optional().describe('SSH port (default: 22)'),
    username: z.string().optional().describe('SSH username for the connectivity check'),
    timeout_ms: z.number().int().positive().optional().describe('Connection timeout in milliseconds (default: 5000)'),
  },
  async (input) => {
    try {
      const result = await sshCheckHost(input);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── Connect ──────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
