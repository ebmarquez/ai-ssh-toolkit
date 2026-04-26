/**
 * Unit tests for ssh-multi-execute.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SshMultiExecuteInput } from "../../src/tools/ssh-multi-execute.js";

vi.mock("node-pty", () => ({
  default: { spawn: vi.fn() },
}));

import { sshMultiExecute, executeSingleHost } from "../../src/tools/ssh-multi-execute.js";

function buildPtyMock(opts: {
  outputLines?: string[];
  exitCode?: number;
  passwordPrompt?: boolean;
}) {
  const {
    outputLines = ["user@host:~$ "],
    exitCode = 0,
    passwordPrompt = false,
  } = opts;

  let onExitCb: ((a: { exitCode: number | null }) => void) | null = null;
  const written: string[] = [];

  return {
    written,
    onData(cb: (d: string) => void) {
      Promise.resolve().then(() => {
        if (passwordPrompt) cb("Password: ");
        for (const line of outputLines) cb(line);
        onExitCb?.({ exitCode });
      });
    },
    onExit(cb: (a: { exitCode: number | null }) => void) {
      onExitCb = cb;
    },
    write(data: string) {
      written.push(data);
    },
    kill: vi.fn(),
  };
}

describe("executeSingleHost", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  const baseInput: SshMultiExecuteInput = {
    hosts: ["192.168.1.1"],
    username: "admin",
    commands: ["show version"],
    platform_hint: "linux",
    timeout_per_host: 10,
  };

  it("returns success when SSH exits cleanly", async () => {
    const { default: pty } = await import("node-pty");
    vi.mocked(pty.spawn).mockReturnValue(
      buildPtyMock({ outputLines: ["NX-OS 10.0\r\nuser@host:~$ "] }) as unknown as ReturnType<typeof pty.spawn>,
    );

    const promise = executeSingleHost("192.168.1.1", baseInput);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.host).toBe("192.168.1.1");
    expect(result.success).toBe(true);
    expect(result.output).toContain("NX-OS 10.0");
    expect(result.error).toBeUndefined();
    // Verify rows:0 is passed to prevent --More-- pagination on network devices
    expect(vi.mocked(pty.spawn)).toHaveBeenCalledWith(
      "ssh",
      expect.any(Array),
      expect.objectContaining({ rows: 0 }),
    );
  });

  it("returns failure when SSH exits with non-zero code", async () => {
    const { default: pty } = await import("node-pty");
    vi.mocked(pty.spawn).mockReturnValue(
      buildPtyMock({ exitCode: 255, outputLines: [] }) as unknown as ReturnType<typeof pty.spawn>,
    );

    const promise = executeSingleHost("10.0.0.99", baseInput);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.host).toBe("10.0.0.99");
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("returns timeout failure when host does not respond", async () => {
    const { default: pty } = await import("node-pty");
    const mock = {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
    };
    vi.mocked(pty.spawn).mockReturnValue(mock as unknown as ReturnType<typeof pty.spawn>);

    const promise = executeSingleHost("10.0.0.1", {
      ...baseInput,
      timeout_per_host: 2,
    });

    await vi.advanceTimersByTimeAsync(2001);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/[Tt]imeout/);
    expect(mock.kill).toHaveBeenCalled();
  });
});

describe("sshMultiExecute", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns results for all hosts", async () => {
    const executor = vi.fn(async (host: string) => ({
      host,
      success: host !== "10.0.0.2",
      output: host !== "10.0.0.2" ? `ok-${host}` : undefined,
      error: host === "10.0.0.2" ? "connection refused" : undefined,
      duration_ms: 1,
    }));

    const input: SshMultiExecuteInput = {
      hosts: ["10.0.0.1", "10.0.0.2", "10.0.0.3"],
      username: "admin",
      commands: ["show version"],
    };

    const result = await sshMultiExecute(input, undefined, executor as typeof executeSingleHost);

    expect(result.total_hosts).toBe(3);
    expect(result.results).toHaveLength(3);
    const hostMap = Object.fromEntries(result.results.map((r) => [r.host, r]));
    expect(hostMap["10.0.0.1"].success).toBe(true);
    expect(hostMap["10.0.0.2"].success).toBe(false);
    expect(hostMap["10.0.0.3"].success).toBe(true);
    expect(result.successful).toBe(2);
    expect(result.failed).toBe(1);
  });

  it("one failing host does not prevent others from running", async () => {
    const attempted: string[] = [];
    const executor = vi.fn(async (host: string) => {
      attempted.push(host);
      if (host === "10.0.0.1") {
        return { host, success: false, error: "boom", duration_ms: 1 };
      }
      return { host, success: true, output: "ok", duration_ms: 1 };
    });

    const result = await sshMultiExecute(
      {
        hosts: ["10.0.0.1", "10.0.0.2", "10.0.0.3"],
        username: "admin",
        commands: ["hostname"],
      },
      undefined,
      executor as typeof executeSingleHost,
    );

    expect(attempted).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
    expect(result.results).toHaveLength(3);
    expect(result.failed).toBe(1);
    expect(result.successful).toBe(2);
  });

  it("respects max_parallel by batching hosts", async () => {
    let activeConcurrent = 0;
    let peakConcurrent = 0;

    const executor = async (host: string) => {
      activeConcurrent++;
      peakConcurrent = Math.max(peakConcurrent, activeConcurrent);
      await new Promise((r) => setTimeout(r, 5));
      activeConcurrent--;
      return { host, success: true, output: "ok", duration_ms: 5 };
    };

    const hosts = Array.from({ length: 15 }, (_, i) => `10.0.0.${i + 1}`);
    await sshMultiExecute(
      {
        hosts,
        username: "admin",
        commands: ["uptime"],
        max_parallel: 5,
      },
      undefined,
      executor as typeof executeSingleHost,
    );

    expect(peakConcurrent).toBeLessThanOrEqual(5);
  }, 10000);

  it("returns empty results for empty host list", async () => {
    const result = await sshMultiExecute({
      hosts: [],
      username: "admin",
      commands: ["hostname"],
    });

    expect(result.total_hosts).toBe(0);
    expect(result.results).toHaveLength(0);
    expect(result.successful).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("tracks wall-clock duration_ms", async () => {
    const executor = vi.fn(async (host: string) => ({
      host,
      success: true,
      output: "ok",
      duration_ms: 3,
    }));

    const result = await sshMultiExecute(
      {
        hosts: ["10.0.0.1"],
        username: "admin",
        commands: ["hostname"],
      },
      undefined,
      executor as typeof executeSingleHost,
    );

    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.results[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("defaults max_parallel to 10 when not specified", async () => {
    let peakConcurrent = 0;
    let activeConcurrent = 0;

    const executor = async (host: string) => {
      activeConcurrent++;
      peakConcurrent = Math.max(peakConcurrent, activeConcurrent);
      await new Promise((r) => setTimeout(r, 5));
      activeConcurrent--;
      return { host, success: true, output: "ok", duration_ms: 5 };
    };

    const hosts = Array.from({ length: 25 }, (_, i) => `10.0.${Math.floor(i / 255)}.${(i % 255) + 1}`);
    await sshMultiExecute(
      { hosts, username: "admin", commands: ["uptime"] },
      undefined,
      executor as typeof executeSingleHost,
    );

    expect(peakConcurrent).toBeLessThanOrEqual(10);
  }, 10000);

  it("sets successful/failed counts correctly", async () => {
    const outcomes: Record<string, boolean> = {
      a: true,
      b: false,
      c: true,
      d: false,
      e: false,
    };

    const executor = vi.fn(async (host: string) => ({
      host,
      success: outcomes[host],
      output: outcomes[host] ? "ok" : undefined,
      error: outcomes[host] ? undefined : "failed",
      duration_ms: 1,
    }));

    const result = await sshMultiExecute(
      {
        hosts: Object.keys(outcomes),
        username: "admin",
        commands: ["test"],
      },
      undefined,
      executor as typeof executeSingleHost,
    );

    expect(result.successful).toBe(2);
    expect(result.failed).toBe(3);
    expect(result.successful + result.failed).toBe(result.total_hosts);
  });
});
