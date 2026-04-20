#!/usr/bin/env node
/**
 * ai-ssh-toolkit MCP server entry point.
 *
 * Creates an McpServer with StdioServerTransport, registers all 5 tools,
 * and connects to the MCP client via stdin/stdout.
 *
 * Tools:
 *  - ssh_execute               (single-host SSH — PTY stub, wired for credentials)
 *  - ssh_multi_execute         (parallel multi-host SSH execution)
 *  - ssh_check_host            (SSH connectivity probe)
 *  - credential_get            (credential metadata, never returns passwords)
 *  - credential_list_backends  (list registered credential backends)
 *  - version_check             (installed vs latest published package version)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v3';

import { sshExecute } from './tools/ssh-execute.js';
import { sshMultiExecute } from './tools/ssh-multi-execute.js';
import { credentialGet } from './tools/credential-get.js';
import { credentialListBackends } from './tools/credential-list.js';
import { sshCheckHost } from './tools/ssh-check.js';
import { versionCheck } from './tools/version-check.js';
import { CredentialRegistry } from './credentials/registry.js';
import { BitwardenBackend } from './credentials/bitwarden.js';
import { AzureKeyVaultBackend } from './credentials/azure-keyvault.js';
import { EnvCredentialBackend } from './credentials/env.js';
import { GoogleSecretManagerBackend } from './credentials/google-secret-manager.js';
import { readFileSync } from 'fs';

function getPackageVersion(): string {
  const packageJsonPath = new URL('../package.json', import.meta.url);
  const raw = readFileSync(packageJsonPath, 'utf-8');
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? '0.0.0';
}

const server = new McpServer(
  { name: 'ai-ssh-toolkit', version: getPackageVersion() },
  { capabilities: { tools: {} } }
);

const registry = new CredentialRegistry();
registry.register(new BitwardenBackend());
registry.register(new AzureKeyVaultBackend());
registry.register(new EnvCredentialBackend());
registry.register(new GoogleSecretManagerBackend());

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
      const result = await sshExecute(registry, input);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── ssh_multi_execute ────────────────────────────────────────────────────────
server.tool(
  'ssh_multi_execute',
  'Execute SSH commands across multiple hosts in parallel.',
  {
    hosts: z.array(z.string()).describe('List of hostnames or IP addresses'),
    username: z.string().describe('SSH username for all hosts'),
    commands: z.array(z.string()).describe('Commands to execute on each host'),
    credential_backend: z.string().optional().describe('Credential backend name'),
    credential_ref: z.string().optional().describe('Credential reference string'),
    platform_hint: z
      .enum(['nxos', 'os10', 'sonic', 'linux', 'auto'])
      .optional()
      .describe('Platform hint for prompt detection'),
    port: z.number().int().min(1).max(65535).optional().describe('SSH port (default: 22)'),
    max_parallel: z.number().int().positive().optional().describe('Max simultaneous connections (default: 10)'),
    timeout_per_host: z.number().int().positive().optional().describe('Per-host timeout in seconds (default: 30)'),
  },
  async (input) => {
    try {
      const result = await sshMultiExecute(input, registry);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
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
      const metadata = await credentialGet(registry, input);
      return { content: [{ type: 'text' as const, text: JSON.stringify(metadata) }] };
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
      const backends = await credentialListBackends(registry);
      return { content: [{ type: 'text' as const, text: JSON.stringify(backends) }] };
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
    port: z.number().int().min(1).max(65535).optional().describe('SSH port (default: 22)'),
    username: z.string().optional().describe('SSH username for the connectivity check'),
    timeout_ms: z.number().int().positive().optional().describe('Connection timeout in milliseconds (default: 5000)'),
  },
  async (input) => {
    try {
      const result = await sshCheckHost(input);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── version_check ────────────────────────────────────────────────────────────
server.tool(
  'version_check',
  'Check installed ai-ssh-toolkit version against latest published npm version.',
  {},
  async () => {
    try {
      const result = await versionCheck();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
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
