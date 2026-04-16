import { PlatformHint, detectPrompt, detectPasswordPrompt } from "../ssh/prompt-detector.js";
import { CredentialRegistry } from "../credentials/registry.js";

export interface SshMultiExecuteInput {
  hosts: string[];
  username: string;
  commands: string[];
  credential_backend?: string;
  credential_ref?: string;
  platform_hint?: PlatformHint;
  port?: number;
  max_parallel?: number;
  timeout_per_host?: number;
}

export interface HostResult {
  host: string;
  success: boolean;
  output?: string;
  error?: string;
  duration_ms: number;
}

export interface SshMultiExecuteOutput {
  results: HostResult[];
  total_hosts: number;
  successful: number;
  failed: number;
  duration_ms: number;
}

/**
 * Execute SSH commands on a single host, returning a HostResult.
 * Exported for testing / reuse.
 */
export async function executeSingleHost(
  host: string,
  input: SshMultiExecuteInput,
  registry?: CredentialRegistry,
): Promise<HostResult> {
  const start = Date.now();

  try {
    // Resolve credentials if a backend is configured
    let password: Buffer | undefined;
    let username = input.username;

    if (input.credential_backend && input.credential_ref && registry) {
      const cred = await registry.getCredential(
        input.credential_backend,
        input.credential_ref,
      );
      username = cred.username;
      password = cred.password;
    }

    const output = await runSshCommands({
      host,
      port: input.port ?? 22,
      username,
      password,
      commands: input.commands,
      platformHint: input.platform_hint ?? "auto",
      timeoutMs: (input.timeout_per_host ?? 30) * 1000,
    });

    // Zero-fill password buffer after use
    if (password) password.fill(0);

    return {
      host,
      success: true,
      output,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      host,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - start,
    };
  }
}

/**
 * Run commands on multiple hosts in parallel, respecting max_parallel.
 */
export async function sshMultiExecute(
  input: SshMultiExecuteInput,
  registry?: CredentialRegistry,
  executor: typeof executeSingleHost = executeSingleHost,
): Promise<SshMultiExecuteOutput> {
  const wallStart = Date.now();
  const maxParallel = input.max_parallel ?? 10;
  const hosts = input.hosts;

  const results: HostResult[] = [];

  // Process in batches of max_parallel
  for (let i = 0; i < hosts.length; i += maxParallel) {
    const batch = hosts.slice(i, i + maxParallel);
    const settled = await Promise.allSettled(
      batch.map((host) => executor(host, input, registry)),
    );

    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
      } else {
        // Unexpected — executeSingleHost catches internally, but handle defensively
        results.push({
          host: "unknown",
          success: false,
          error: outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
          duration_ms: 0,
        });
      }
    }
  }

  const successful = results.filter((r) => r.success).length;

  return {
    results,
    total_hosts: hosts.length,
    successful,
    failed: hosts.length - successful,
    duration_ms: Date.now() - wallStart,
  };
}

// ---------------------------------------------------------------------------
// Internal SSH execution using node-pty
// ---------------------------------------------------------------------------

interface RunSshOptions {
  host: string;
  port: number;
  username: string;
  password?: Buffer;
  commands: string[];
  platformHint: PlatformHint;
  timeoutMs: number;
}

/**
 * Low-level SSH runner using node-pty.
 * Throws on connection failure or timeout.
 */
async function runSshCommands(opts: RunSshOptions): Promise<string> {
  // Dynamic import to allow mocking in tests
  const { default: pty } = await import("node-pty");

  const { host, port, username, password, commands, platformHint, timeoutMs } = opts;

  return new Promise<string>((resolve, reject) => {
    const sshArgs = [
      "-o", "StrictHostKeyChecking=no",
      "-o", "BatchMode=no",
      "-o", `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
      "-p", String(port),
      `${username}@${host}`,
    ];

    const proc = pty.spawn("ssh", sshArgs, {
      name: "xterm-color",
      cols: 220,
      rows: 40,
      env: process.env as Record<string, string>,
    });

    let outputBuf = "";
    let authenticated = false;
    let cmdIndex = 0;
    const allCommands = [...commands, "exit"];

    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${timeoutMs}ms connecting to ${host}`));
      proc.kill();
    }, timeoutMs);

    proc.onData((data: string) => {
      outputBuf += data;

      if (!authenticated && detectPasswordPrompt(outputBuf)) {
        if (password) {
          proc.write(password.toString("utf-8") + "\r");
          authenticated = true;
          outputBuf = "";
        } else {
          clearTimeout(timer);
          proc.kill();
          reject(new Error(`Password required for ${host} but none provided`));
        }
        return;
      }

      if (detectPrompt(outputBuf, platformHint)) {
        if (cmdIndex < allCommands.length) {
          proc.write(allCommands[cmdIndex++] + "\r");
        }
      }
    });

    proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode === 0 || exitCode === null) {
        resolve(outputBuf.trim());
      } else {
        reject(new Error(`SSH exited with code ${exitCode} for ${host}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// MCP tool definition (JSON Schema + handler)
// ---------------------------------------------------------------------------

export const SSH_MULTI_EXECUTE_TOOL = {
  name: "ssh_multi_execute",
  description:
    "Execute SSH commands on multiple hosts in parallel. " +
    "Returns per-host results; failed hosts do not stop others.",
  inputSchema: {
    type: "object",
    required: ["hosts", "username", "commands"],
    properties: {
      hosts: {
        type: "array",
        items: { type: "string" },
        description: "List of hostnames or IP addresses",
        minItems: 1,
      },
      username: {
        type: "string",
        description: "SSH username",
      },
      commands: {
        type: "array",
        items: { type: "string" },
        description: "Commands to run on each host",
        minItems: 1,
      },
      credential_backend: {
        type: "string",
        enum: ["bitwarden", "azure-keyvault", "env"],
        description: "Credential backend to use for authentication",
      },
      credential_ref: {
        type: "string",
        description: "Backend-specific credential reference",
      },
      platform_hint: {
        type: "string",
        enum: ["nxos", "os10", "sonic", "linux", "auto"],
        description: "Target platform for prompt detection (default: auto)",
      },
      port: {
        type: "number",
        description: "SSH port (default: 22)",
        default: 22,
      },
      max_parallel: {
        type: "number",
        description: "Maximum concurrent SSH connections (default: 10)",
        default: 10,
        minimum: 1,
      },
      timeout_per_host: {
        type: "number",
        description: "Per-host timeout in seconds (default: 30)",
        default: 30,
        minimum: 1,
      },
    },
  },
} as const;
