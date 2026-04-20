/**
 * Smoke test: verify the MCP server starts, responds to initialize,
 * and registers all expected tools.
 *
 * Sends JSON-RPC messages via stdin/stdout (no transport library needed).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const DIST_INDEX = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../dist/index.js');
const PACKAGE_JSON = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../package.json');
const PACKAGE_VERSION = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8')).version;

const EXPECTED_TOOLS = ['ssh_execute', 'ssh_multi_execute', 'credential_get', 'credential_list_backends', 'ssh_check_host', 'version_check'];

/**
 * Send one or more newline-delimited JSON-RPC messages to the server via stdin,
 * and collect all newline-delimited JSON responses from stdout.
 */
function sendMessages(messages: object[]): object[] {
  const input = messages.map(m => JSON.stringify(m)).join('\n') + '\n';

  const stdout = execFileSync('node', [DIST_INDEX], {
    input,
    encoding: 'utf-8',
    timeout: 10_000,
  });

  return stdout
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

describe('MCP server smoke test', () => {
  it('responds to initialize with correct serverInfo and capabilities', () => {
    const responses = sendMessages([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '1.0' },
        },
      },
    ]);

    expect(responses.length).toBeGreaterThan(0);
    const initResponse = responses.find((r: any) => r.id === 1) as any;
    expect(initResponse).toBeDefined();
    expect(initResponse.result.serverInfo.name).toBe('ai-ssh-toolkit');
    expect(initResponse.result.serverInfo.version).toBe(PACKAGE_VERSION);
    expect(initResponse.result.capabilities.tools).toBeDefined();
  });

  it('credential_list_backends includes the expected registered backends', () => {
    const responses = sendMessages([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '1.0' },
        },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'notifications/initialized',
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'credential_list_backends',
          arguments: {},
        },
      },
    ]);

    const backendsResponse = responses.find((r: any) => r.id === 3) as any;
    expect(backendsResponse).toBeDefined();
    const text = backendsResponse.result.content[0].text;
    const backends = JSON.parse(text) as Array<{ name: string; available: boolean }>;
    const names = backends.map((b) => b.name);

    expect(names).toContain('bitwarden');
    expect(names).toContain('azure-keyvault');
    expect(names).toContain('env');
    expect(names).toContain('google-secret-manager');
  });

  it('tools/list returns all expected tools', () => {
    const responses = sendMessages([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '1.0' },
        },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'notifications/initialized',
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
        params: {},
      },
    ]);

    const toolsResponse = responses.find((r: any) => r.id === 3) as any;
    expect(toolsResponse).toBeDefined();
    expect(toolsResponse.result.tools).toBeDefined();

    const toolNames: string[] = toolsResponse.result.tools.map((t: any) => t.name);
    for (const expected of EXPECTED_TOOLS) {
      expect(toolNames).toContain(expected);
    }
  });
});
