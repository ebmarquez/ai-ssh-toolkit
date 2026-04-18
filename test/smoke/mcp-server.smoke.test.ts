/**
 * Smoke test: verify the MCP server starts, responds to initialize,
 * and registers all 4 expected tools.
 *
 * Sends JSON-RPC messages via stdin/stdout (no transport library needed).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const DIST_INDEX = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../dist/index.js');

const EXPECTED_TOOLS = ['ssh_execute', 'ssh_multi_execute', 'credential_get', 'credential_list_backends', 'ssh_check_host'];

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
    expect(initResponse.result.capabilities.tools).toBeDefined();
  });

  it('tools/list returns all 4 expected tools', () => {
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
