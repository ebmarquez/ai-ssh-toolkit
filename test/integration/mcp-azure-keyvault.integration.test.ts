/**
 * End-to-end MCP integration test: packaged server + Azure Key Vault + real SSH.
 *
 * Requires:
 *   - AZURE_KV_ENABLED=true
 *   - SSH_E2E_ENABLED=true
 *   - az CLI authenticated
 *   - surface-aac-1.local reachable via SSH (local network only)
 *
 * NOTE: This test is intentionally excluded from CI (surface-aac-1.local is not
 * reachable from GitHub runners). Run locally only.
 *
 * Run locally:
 *   AZURE_KV_ENABLED=true SSH_E2E_ENABLED=true npx vitest run test/integration/mcp-azure-keyvault.integration.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execSync, spawn, ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const SKIP_KV = process.env.AZURE_KV_ENABLED !== 'true';
const SKIP_SSH = process.env.SSH_E2E_ENABLED !== 'true';
const SKIP = SKIP_KV || SKIP_SSH;

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

/**
 * Send JSON-RPC messages to the MCP server via stdin and collect stdout responses.
 * Uses a long-lived server process for the E2E test.
 */
function sendMcpMessages(serverPath: string, messages: object[], timeoutMs = 60_000): Promise<object[]> {
  return new Promise((resolve, reject) => {
    const proc: ChildProcess = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on('data', (_chunk: Buffer) => {
      // Suppress server stderr in test output
    });

    proc.on('error', reject);

    // Set up timeout before registering close handler so it is always defined
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`MCP server timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const lines = stdout
          .split('\n')
          .filter(l => l.trim().length > 0)
          .map(l => JSON.parse(l));
        resolve(lines);
      } catch (parseErr) {
        reject(new Error(`Failed to parse MCP responses: ${parseErr}\nRaw stdout: ${stdout}`));
      }
    });

    // Write all messages then close stdin so the server exits cleanly
    const input = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
    proc.stdin?.write(input);
    proc.stdin?.end();
  });
}

describe.skipIf(SKIP)('MCP + Azure Key Vault + SSH E2E', { timeout: 60_000 }, () => {
  let tmpDir: string;
  let serverPath: string;

  // Pack and install the tarball in a temp dir once for all tests
  // (vitest doesn't support beforeAll returning a value we can use for path,
  //  so we do it synchronously at describe scope)
  try {
    if (!SKIP) {
      tmpDir = mkdtempSync(resolve(tmpdir(), 'mcp-e2e-'));

      // Pack the tarball from repo root
      const packOutput = execSync('npm pack --json', {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      });
      const tarball = JSON.parse(packOutput)[0].filename;
      const tarballPath = resolve(REPO_ROOT, tarball);

      // Install into temp dir
      execSync(`npm install --prefix ${tmpDir} ${tarballPath}`, { encoding: 'utf-8' });

      // Server entrypoint inside the installed package
      serverPath = resolve(tmpDir, 'node_modules/ai-ssh-toolkit/dist/index.js');
    }
  } catch {
    // If pack/install fails, tests will fail at runtime — that's correct behavior
  }

  afterAll(() => {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
    // Clean up tarball left in repo root
    try {
      execSync('rm -f *.tgz', { cwd: REPO_ROOT });
    } catch {
      // Ignore
    }
  });

  it('ssh_execute via azure-keyvault backend returns exit_code 0 and hostname output', async () => {
    const responses = await sendMcpMessages(serverPath!, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'e2e-test', version: '1.0' },
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
          name: 'ssh_execute',
          arguments: {
            host: 'surface-aac-1.local',
            command: 'hostname',
            credential_backend: 'azure-keyvault',
            credential_ref: 'rg-ut-bw/surface-aac-1',
          },
        },
      },
    ], 60_000);

    const toolResponse = responses.find((r: any) => r.id === 3) as any;
    expect(toolResponse).toBeDefined();
    expect(toolResponse.result).toBeDefined();

    const resultText: string = toolResponse.result.content?.[0]?.text ?? '';
    let parsed: any;
    try {
      parsed = JSON.parse(resultText);
    } catch {
      throw new Error(`Expected JSON result from ssh_execute, got: ${resultText}`);
    }

    expect(parsed.exit_code).toBe(0);
    expect(parsed.stdout ?? parsed.output ?? '').toContain('surface-aac-1');
  });
});
