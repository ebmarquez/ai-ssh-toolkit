import { PlatformHint, detectPrompt, detectPasswordPrompt } from "../ssh/prompt-detector.js";
import { scrubOutput } from "../ssh/output-scrubber.js";
import { CredentialRegistry } from "../credentials/registry.js";
import { SSH_PTY_OPTIONS } from "../ssh/pty-options.js";

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
  // Validate credential params upfront
  if ((input.credential_backend && !input.credential_ref) ||
      (!input.credential_backend && input.credential_ref)) {
    return {
      host,
      success: false,
      error: 'credential_backend and credential_ref must both be provided together',
      duration_ms: 0,
    };
  }
  if (input.credential_backend && !registry) {
    return {
      host,
      success: false,
      error: 'credential_backend requested but no registry available',
      duration_ms: 0,
    };
  }

  const start = Date.now();

  let password: Buffer | undefined;
  try {
    // Resolve credentials if a backend is configured
    let username = input.username;

    if (input.credential_backend && input.credential_ref && registry) {
      const backend = registry.getBackend(input.credential_backend);
      try {
        const cred = await registry.getCredential(
          input.credential_backend,
          input.credential_ref,
        );
        username = cred.username;
        password = cred.password;
      } finally {
        await backend.cleanup();
      }
    }

    const rawOutput = await runSshCommands({
      host,
      port: input.port ?? 22,
      username,
      password,
      commands: input.commands,
      platformHint: input.platform_hint ?? "auto",
      timeoutMs: (input.timeout_per_host ?? 30) * 1000,
    });

    const output = scrubOutput(rawOutput);

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
  } finally {
    // Always zero-fill password buffer — success or failure
    if (password) password.fill(0);
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
  const maxParallel = Math.max(1, Math.floor(input.max_parallel ?? 10));
  if (!Number.isFinite(maxParallel)) {
    throw new Error('max_parallel must be a finite positive integer');
  }
  const hosts = input.hosts;

  // True concurrency limiter: slots fill as hosts complete, not in fixed batches.
  // This prevents slow hosts from blocking idle slots.
  let activeSlots = 0;
  const results: HostResult[] = new Array(hosts.length);
  const queue = hosts.map((host, idx) => ({ host, idx }));
  let queuePos = 0;

  await new Promise<void>((resolveAll) => {
    if (hosts.length === 0) {
      resolveAll();
      return;
    }

    let completed = 0;

    const runNext = () => {
      while (activeSlots < maxParallel && queuePos < queue.length) {
        const { host, idx } = queue[queuePos++];
        activeSlots++;

        executor(host, input, registry)
          .catch((err): HostResult => ({
            // Capture host in closure so rejection fallback has the right name
            host,
            success: false,
            error: err instanceof Error ? err.message : String(err),
            duration_ms: 0,
          }))
          .then((result) => {
            results[idx] = result;
            activeSlots--;
            completed++;
            if (completed === hosts.length) {
              resolveAll();
            } else {
              runNext();
            }
          });
      }
    };

    runNext();
  });

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
      // Honor ~/.ssh/config for StrictHostKeyChecking — user's config wins.
      // Default behavior without this flag: whatever ssh_config specifies.
      "-o", "ForwardAgent=no",
      "-o", "BatchMode=no",
      "-o", `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
      "-p", String(port),
      `${username}@${host}`,
    ];

    const childEnv: Record<string, string> = {};
    const allowlist = [
      "HOME",
      "PATH",
      "TERM",
      "LANG",
      "LC_ALL",
      // SSH config / agent vars
      "SSH_AUTH_SOCK",
      "SSH_AGENT_PID",
      // Windows/platform-critical vars
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "SystemRoot",
      "WINDIR",
      "ComSpec",
      "PATHEXT",
      "TEMP",
      "TMP",
    ];
    for (const key of allowlist) {
      const value = process.env[key];
      if (value) childEnv[key] = value;
    }
    childEnv.TERM ??= "xterm-color";

    const proc = pty.spawn("ssh", sshArgs, {
      ...SSH_PTY_OPTIONS,
      // Intentionally pass only the allowlisted child environment here
      // instead of process.env to avoid leaking unrelated or sensitive
      // parent-process variables into the SSH child process.
      env: childEnv,
    });

    let outputBuf = "";
    let authenticated = false;
    let cmdIndex = 0;
    const allCommands = [...commands, "exit"];

    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${timeoutMs}ms during SSH session execution on ${host}`));
      proc.kill();
    }, timeoutMs);

    proc.onData((data: string) => {
      outputBuf += data;

      if (!authenticated && detectPasswordPrompt(outputBuf)) {
        if (password) {
          // node-pty write() is string-based, so preserve the intended UTF-8
          // characters for non-ASCII passwords. The Buffer is still zeroed in
          // the caller's finally block after session completion.
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
        minItems: 0,
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
