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
import { sshSessionOpen } from './tools/ssh-session-open.js';
import { sshSessionExecute } from './tools/ssh-session-execute.js';
import { sshSessionClose } from './tools/ssh-session-close.js';
import { SessionStore } from './ssh/session-store.js';
import { sshMultiExecute } from './tools/ssh-multi-execute.js';
import { credentialGet } from './tools/credential-get.js';
import { credentialListBackends } from './tools/credential-list.js';
import { sshCheckHost } from './tools/ssh-check.js';
import { sshHostInfo } from './tools/ssh-host-info.js';
import { sshHostKeyTrust } from './tools/ssh-host-key-trust.js';
import { sshHostKeyList } from './tools/ssh-host-key-list.js';
import { sshHostKeyRemove } from './tools/ssh-host-key-remove.js';
import { versionCheck } from './tools/version-check.js';
import { credentialDiagnose } from './tools/credential-diagnose.js';
import { sshForwardLocal } from './tools/ssh-forward-local.js';
import { sshForwardRemote } from './tools/ssh-forward-remote.js';
import { sshForwardDynamic } from './tools/ssh-forward-dynamic.js';
import { sshForwardClose } from './tools/ssh-forward-close.js';
import { sshForwardList } from './tools/ssh-forward-list.js';
import { destroyAllForwards } from './ssh/forward-manager.js';
import { CredentialRegistry } from './credentials/registry.js';
import { CredentialMap } from './credentials/credential-map.js';
import { HostKeyStore } from './security/host-key-store.js';
import { BitwardenBackend } from './credentials/bitwarden.js';
import { AzureKeyVaultBackend } from './credentials/azure-keyvault.js';
import { EnvCredentialBackend } from './credentials/env.js';
import { GoogleSecretManagerBackend } from './credentials/google-secret-manager.js';
import { SshAgentBackend } from './credentials/ssh-agent.js';
import { AuditLogger } from './audit/audit-logger.js';
import { readFileSync } from 'fs';

function getPackageVersion(): string {
  const packageJsonPath = new URL('../package.json', import.meta.url);
  try {
    const raw = readFileSync(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch (err: unknown) {
    process.stderr.write(
      `Warning: failed to read package version from ${packageJsonPath.toString()}: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    return '0.0.0';
  }
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
registry.register(new SshAgentBackend());

const sessionStore = new SessionStore();
const credentialMap = new CredentialMap();
const auditLogger = new AuditLogger();
const hostKeyStore = new HostKeyStore();

// Graceful shutdown: destroy all sessions and forwards before exiting
const shutdown = () => { destroyAllForwards(); sessionStore.destroy(); process.exit(0); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.on('exit', () => { destroyAllForwards(); sessionStore.destroy(); });

// ── ssh_execute ──────────────────────────────────────────────────────────────
server.tool(
  'ssh_execute',
  'Execute a command on a remote host via an interactive SSH PTY session.',
  {
    host: z.string().describe('Hostname or IP address of the remote target'),
    command: z.string().describe('Command to execute on the remote host'),
    username: z.string().optional().describe('SSH username (overrides credential ref username and ~/.ssh/config User)'),
    credential_ref: z.string().optional().describe('Credential reference string understood by the selected backend'),
    credential_backend: z.string().optional().describe('Name of the credential backend (default: google-secret-manager)'),
    platform: z
      .enum(['nxos', 'os10', 'sonic', 'linux', 'auto'])
      .optional()
      .describe('Platform hint for prompt detection (default: auto)'),
    timeout_ms: z.number().int().positive().optional().describe('Connection + command timeout in milliseconds (default: 30000)'),
    use_ssh_config: z.boolean().optional().describe('When true (default), honor ~/.ssh/config for User, Port, IdentityFile, ProxyJump, etc. Set false to skip.'),
    dry_run: z.boolean().optional().describe('When true, resolve host/credentials/args but do NOT connect. Returns a preview of the SSH invocation.'),
    max_output_bytes: z.number().int().positive().optional().describe('Maximum output size in bytes before truncation (default: 65536 = 64 KB). Output exceeding this limit is saved to a file and a head/tail preview is returned inline.'),
    output_to_file: z.string().optional().describe('If provided, always write full output to this file path (plus return head/tail inline).'),
    jump_hosts: z.array(z.string()).optional().describe('ProxyJump chain: list of bastion/jump hosts, e.g. ["bastion1.example.com","bastion2.internal"]. Translated to ssh -J flag.'),
  },
  async (input) => {
    const start = Date.now();
    try {
      const result = await sshExecute(registry, input, credentialMap, hostKeyStore);
      auditLogger.log({
        tool: 'ssh_execute',
        host: input.host,
        username: input.username ?? '',
        credential_backend: input.credential_backend,
        command: input.command,
        exit_code: result.exit_code,
        duration_ms: Date.now() - start,
        stdout_bytes: Buffer.byteLength(result.output, 'utf-8'),
        success: true,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err: unknown) {
      auditLogger.log({
        tool: 'ssh_execute',
        host: input.host,
        username: input.username ?? '',
        credential_backend: input.credential_backend,
        command: input.command,
        duration_ms: Date.now() - start,
        success: false,
      });
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
      const result = await sshMultiExecute(input, registry, credentialMap);
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
  'Verify SSH host reachability via TCP connect, SSH banner probe (default), or full auth check.',
  {
    host: z.string().describe('Hostname or IP address to check'),
    port: z.number().int().min(1).max(65535).optional().describe('SSH port (default: 22, or from ~/.ssh/config)'),
    username: z.string().optional().describe('SSH username for the connectivity check'),
    timeout_ms: z.number().int().positive().optional().describe('Connection timeout in milliseconds (default: 5000)'),
    mode: z.enum(['tcp', 'banner', 'auth']).optional().describe("Check mode: 'tcp' (TCP connect only), 'banner' (TCP + SSH banner read, default), 'auth' (full ssh binary auth with BatchMode=yes)"),
    use_ssh_config: z.boolean().optional().describe('When true (default), honor ~/.ssh/config for User, Port, IdentityFile, ProxyJump, etc. Set false to skip.'),
    jump_hosts: z.array(z.string()).optional().describe('ProxyJump chain: list of bastion/jump hosts. Used in auth mode to route through bastions. Translated to ssh -J flag.'),
  },
  async (input) => {
    const start = Date.now();
    try {
      const result = await sshCheckHost(input, credentialMap);
      auditLogger.log({
        tool: 'ssh_check_host',
        host: input.host,
        username: input.username ?? '',
        duration_ms: Date.now() - start,
        success: result.reachable,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err: unknown) {
      auditLogger.log({
        tool: 'ssh_check_host',
        host: input.host,
        username: input.username ?? '',
        duration_ms: Date.now() - start,
        success: false,
      });
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── ssh_session_open ─────────────────────────────────────────────────────────
server.tool(
  'ssh_session_open',
  'Open a persistent interactive SSH shell session. Returns a session_id for use with ssh_session_execute and ssh_session_close.',
  {
    host: z.string().describe('Hostname or IP address of the remote target'),
    username: z.string().optional().describe('SSH username (overrides credential ref username and ~/.ssh/config User)'),
    credential_ref: z.string().optional().describe('Credential reference string understood by the selected backend'),
    credential_backend: z.string().optional().describe('Name of the credential backend (default: google-secret-manager)'),
    platform: z
      .enum(['nxos', 'os10', 'sonic', 'linux', 'auto'])
      .optional()
      .describe('Platform hint for prompt detection (default: auto)'),
    timeout_ms: z.number().int().positive().optional().describe('Connect + initial prompt timeout in milliseconds (default: 30000)'),
    idle_timeout_ms: z.number().int().positive().optional().describe('Inactivity auto-close timeout in milliseconds (default: 300000)'),
    use_ssh_config: z.boolean().optional().describe('When true (default), honor ~/.ssh/config for User, Port, IdentityFile, ProxyJump, etc. Set false to skip.'),
    dry_run: z.boolean().optional().describe('When true, resolve host/credentials/args but do NOT connect. Returns a preview of the SSH invocation.'),
    jump_hosts: z.array(z.string()).optional().describe('ProxyJump chain: list of bastion/jump hosts, e.g. ["bastion1.example.com"]. Translated to ssh -J flag.'),
  },
  async (input) => {
    const start = Date.now();
    try {
      const result = await sshSessionOpen(registry, sessionStore, input, credentialMap, hostKeyStore);
      auditLogger.log({
        tool: 'ssh_session_open',
        host: input.host,
        username: result.username,
        credential_backend: input.credential_backend,
        duration_ms: Date.now() - start,
        success: true,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err: unknown) {
      auditLogger.log({
        tool: 'ssh_session_open',
        host: input.host,
        username: input.username ?? '',
        credential_backend: input.credential_backend,
        duration_ms: Date.now() - start,
        success: false,
      });
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── ssh_session_execute ───────────────────────────────────────────────────────
server.tool(
  'ssh_session_execute',
  'Execute a command inside an open persistent SSH session.',
  {
    session_id: z.string().describe('Session ID returned by ssh_session_open'),
    command: z.string().describe('Command to execute in the session'),
    timeout_ms: z.number().int().positive().optional().describe('Command timeout in milliseconds (default: 30000)'),
    max_output_bytes: z.number().int().positive().optional().describe('Maximum output size in bytes before truncation (default: 65536 = 64 KB). Output exceeding this limit is saved to a file and a head/tail preview is returned inline.'),
    output_to_file: z.string().optional().describe('If provided, always write full output to this file path (plus return head/tail inline).'),
  },
  async (input) => {
    const start = Date.now();
    const session = sessionStore.get(input.session_id);
    try {
      const result = await sshSessionExecute(sessionStore, input);
      auditLogger.log({
        tool: 'ssh_session_execute',
        host: session?.host ?? '',
        username: session?.username ?? '',
        command: input.command,
        exit_code: result.exit_code,
        duration_ms: Date.now() - start,
        stdout_bytes: Buffer.byteLength(result.output, 'utf-8'),
        success: true,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err: unknown) {
      auditLogger.log({
        tool: 'ssh_session_execute',
        host: session?.host ?? '',
        username: session?.username ?? '',
        command: input.command,
        duration_ms: Date.now() - start,
        success: false,
      });
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── ssh_session_close ─────────────────────────────────────────────────────────
server.tool(
  'ssh_session_close',
  'Close a persistent SSH session opened with ssh_session_open.',
  {
    session_id: z.string().describe('Session ID returned by ssh_session_open'),
  },
  async (input) => {
    const start = Date.now();
    const session = sessionStore.get(input.session_id);
    try {
      const result = await sshSessionClose(sessionStore, input);
      auditLogger.log({
        tool: 'ssh_session_close',
        host: session?.host ?? '',
        username: session?.username ?? '',
        duration_ms: Date.now() - start,
        success: true,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err: unknown) {
      auditLogger.log({
        tool: 'ssh_session_close',
        host: session?.host ?? '',
        username: session?.username ?? '',
        duration_ms: Date.now() - start,
        success: false,
      });
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── credential_diagnose ──────────────────────────────────────────────────────
server.tool(
  'credential_diagnose',
  'Diagnose credential map resolution for a given host. Shows which rule matched and whether the backend is available.',
  {
    host: z.string().describe('Hostname or IP address to diagnose credential resolution for'),
  },
  async (input) => {
    try {
      const result = await credentialDiagnose(registry, input, credentialMap);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── credential_map_reload ─────────────────────────────────────────────────────
server.tool(
  'credential_map_reload',
  'Reload the credential map configuration from disk.',
  {},
  async () => {
    try {
      credentialMap.reload();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, path: credentialMap.getFilePath() }) }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── ssh_forward_local ─────────────────────────────────────────────────────────
server.tool(
  'ssh_forward_local',
  'Start a local SSH port forward (-L). Binds a local port and tunnels traffic to a remote host:port through the SSH server. Uses key/agent auth (BatchMode).',
  {
    host: z.string().describe('SSH server hostname or IP address'),
    local_port: z.number().int().min(1).max(65535).describe('Local port to bind'),
    remote_host: z.string().describe('Remote host to forward traffic to (as seen from SSH server)'),
    remote_port: z.number().int().min(1).max(65535).describe('Remote port to forward traffic to'),
    username: z.string().optional().describe('SSH username'),
    credential_backend: z.string().optional().describe('Credential backend name'),
    credential_ref: z.string().optional().describe('Credential reference string'),
    idle_timeout_seconds: z.number().int().positive().optional().describe('Max lifetime in seconds before auto-close (default: 3600)'),
    use_ssh_config: z.boolean().optional().describe('Honor ~/.ssh/config (default: true)'),
  },
  async (input) => {
    try {
      const result = await sshForwardLocal(registry, input, credentialMap);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── ssh_forward_remote ───────────────────────────────────────────────────────
server.tool(
  'ssh_forward_remote',
  'Start a remote SSH port forward (-R). Binds a port on the SSH server and tunnels traffic back to a local host:port. Uses key/agent auth (BatchMode).',
  {
    host: z.string().describe('SSH server hostname or IP address'),
    remote_port: z.number().int().min(1).max(65535).describe('Remote port to bind on SSH server'),
    local_host: z.string().describe('Local host to forward traffic to'),
    local_port: z.number().int().min(1).max(65535).describe('Local port to forward traffic to'),
    username: z.string().optional().describe('SSH username'),
    credential_backend: z.string().optional().describe('Credential backend name'),
    credential_ref: z.string().optional().describe('Credential reference string'),
    idle_timeout_seconds: z.number().int().positive().optional().describe('Max lifetime in seconds before auto-close (default: 3600)'),
    use_ssh_config: z.boolean().optional().describe('Honor ~/.ssh/config (default: true)'),
  },
  async (input) => {
    try {
      const result = await sshForwardRemote(registry, input, credentialMap);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── ssh_forward_dynamic ──────────────────────────────────────────────────────
server.tool(
  'ssh_forward_dynamic',
  'Start a dynamic SOCKS proxy SSH forward (-D). Binds a local port as a SOCKS proxy through the SSH server. Uses key/agent auth (BatchMode).',
  {
    host: z.string().describe('SSH server hostname or IP address'),
    local_port: z.number().int().min(1).max(65535).describe('Local port to bind as SOCKS proxy'),
    username: z.string().optional().describe('SSH username'),
    credential_backend: z.string().optional().describe('Credential backend name'),
    credential_ref: z.string().optional().describe('Credential reference string'),
    idle_timeout_seconds: z.number().int().positive().optional().describe('Max lifetime in seconds before auto-close (default: 3600)'),
    use_ssh_config: z.boolean().optional().describe('Honor ~/.ssh/config (default: true)'),
  },
  async (input) => {
    try {
      const result = await sshForwardDynamic(registry, input, credentialMap);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── ssh_forward_close ────────────────────────────────────────────────────────
server.tool(
  'ssh_forward_close',
  'Close an active SSH port forward.',
  {
    forward_id: z.string().describe('Forward ID returned by ssh_forward_local/remote/dynamic'),
  },
  async (input) => {
    try {
      const result = sshForwardClose(input);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── ssh_forward_list ─────────────────────────────────────────────────────────
server.tool(
  'ssh_forward_list',
  'List all active SSH port forwards with their status and configuration.',
  {},
  async () => {
    try {
      const result = sshForwardList();
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

// ── ssh_audit_log_read ────────────────────────────────────────────────────────
server.tool(
  'ssh_audit_log_read',
  'Read the last N audit log records from the file destination (if configured via AI_SSH_AUDIT_LOG).',
  {
    limit: z.number().int().positive().optional().describe('Number of recent records to return (default: 50)'),
  },
  async (input) => {
    try {
      if (!auditLogger.logFilePath) {
        return {
          content: [{ type: 'text' as const, text: 'Error: No audit log file configured. Set AI_SSH_AUDIT_LOG=<filepath> to enable.' }],
          isError: true,
        };
      }
      const records = auditLogger.readLastRecords(input.limit ?? 50);
      return { content: [{ type: 'text' as const, text: JSON.stringify(records, null, 2) }] };
// ── ssh_host_info ────────────────────────────────────────────────────────────
server.tool(
  'ssh_host_info',
  'Retrieve SSH host information (banner, OS hint, host key fingerprints) without authentication.',
  {
    host: z.string().describe('Hostname or IP address to probe'),
    port: z.number().int().min(1).max(65535).optional().describe('SSH port (default: 22)'),
    timeout_ms: z.number().int().positive().optional().describe('Timeout in milliseconds (default: 5000)'),
    use_ssh_config: z.boolean().optional().describe('When true (default), honor ~/.ssh/config. Set false to skip.'),
  },
  async (input) => {
    try {
      const result = await sshHostInfo(input);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── ssh_host_key_trust ───────────────────────────────────────────────────────
server.tool(
  'ssh_host_key_trust',
  'Pin or re-pin a host key fingerprint. If fingerprint is omitted, fetches live keys from the host.',
  {
    host: z.string().describe('Hostname or IP address to trust'),
    port: z.number().int().min(1).max(65535).optional().describe('SSH port (default: 22)'),
    fingerprint: z.string().optional().describe('SHA256 fingerprint to pin (e.g. "SHA256:abc..."). If omitted, fetches live keys.'),
    key_type: z.string().optional().describe('Key type when pinning a specific fingerprint (e.g. "ssh-ed25519")'),
    use_ssh_config: z.boolean().optional().describe('When true (default), honor ~/.ssh/config. Set false to skip.'),
  },
  async (input) => {
    try {
      const result = await sshHostKeyTrust(hostKeyStore, input);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── ssh_host_key_list ────────────────────────────────────────────────────────
server.tool(
  'ssh_host_key_list',
  'List all pinned host key fingerprints.',
  {},
  async () => {
    try {
      const result = sshHostKeyList(hostKeyStore);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ── ssh_host_key_remove ──────────────────────────────────────────────────────
server.tool(
  'ssh_host_key_remove',
  'Remove a pinned host key, forgetting a previously trusted host.',
  {
    host: z.string().describe('Hostname or IP address to remove'),
    port: z.number().int().min(1).max(65535).optional().describe('SSH port (default: 22)'),
  },
  async (input) => {
    try {
      const result = sshHostKeyRemove(hostKeyStore, input);
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
