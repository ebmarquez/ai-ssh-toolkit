import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SshAgentBackend } from "../../src/credentials/ssh-agent.js";

// Mock child_process.execFile
vi.mock("child_process", () => {
  const mockExecFile = vi.fn();
  return {
    execFile: mockExecFile,
  };
});

// Mock util.promisify to return our mock directly
vi.mock("util", async () => {
  const actual = await vi.importActual<typeof import("util")>("util");
  return {
    ...actual,
    promisify: (fn: unknown) => fn,
  };
});

import { execFile } from "child_process";
const mockExecFile = vi.mocked(execFile);

describe("SshAgentBackend", () => {
  let backend: SshAgentBackend;
  const savedAuthSock = process.env.SSH_AUTH_SOCK;
  const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(() => {
    backend = new SshAgentBackend();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore SSH_AUTH_SOCK
    if (savedAuthSock !== undefined) {
      process.env.SSH_AUTH_SOCK = savedAuthSock;
    } else {
      delete process.env.SSH_AUTH_SOCK;
    }
    // Restore platform
    if (savedPlatform) {
      Object.defineProperty(process, "platform", savedPlatform);
    }
  });

  describe("name", () => {
    it("should be 'ssh-agent'", () => {
      expect(backend.name).toBe("ssh-agent");
    });
  });

  describe("isAvailable", () => {
    it("should return false when SSH_AUTH_SOCK is not set", async () => {
      delete process.env.SSH_AUTH_SOCK;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      expect(await backend.isAvailable()).toBe(false);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("should return false when ssh-add -l fails (agent not running)", async () => {
      process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
      (mockExecFile as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Could not open connection to agent"),
      );

      expect(await backend.isAvailable()).toBe(false);
    });

    it("should return true when agent has identities", async () => {
      process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
      (mockExecFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: "2048 SHA256:abc123def456 user@host (RSA)\n",
        stderr: "",
      });

      expect(await backend.isAvailable()).toBe(true);
    });

    it("should return false when agent returns empty output", async () => {
      process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
      (mockExecFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: "",
        stderr: "",
      });

      expect(await backend.isAvailable()).toBe(false);
    });

    it("should use Windows named pipe when SSH_AUTH_SOCK not set on Windows", async () => {
      delete process.env.SSH_AUTH_SOCK;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      (mockExecFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: "2048 SHA256:abc123def456 user@host (RSA)\n",
        stderr: "",
      });

      expect(await backend.isAvailable()).toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith(
        "ssh-add",
        ["-l"],
        expect.objectContaining({
          env: expect.objectContaining({
            SSH_AUTH_SOCK: "\\\\.\\pipe\\openssh-ssh-agent",
          }),
        }),
      );
    });
  });

  describe("getCredential", () => {
    it("should return username from ref and empty password Buffer", async () => {
      const result = await backend.getCredential("admin");
      expect(result.username).toBe("admin");
      expect(Buffer.isBuffer(result.password)).toBe(true);
      expect(result.password.length).toBe(0);
    });

    it("should never return key material — password is always empty Buffer", async () => {
      const result = await backend.getCredential("root:SHA256:abc123");
      expect(result.password).toBeInstanceOf(Buffer);
      expect(result.password.length).toBe(0);
    });

    it("should parse username from 'username' ref format", async () => {
      const result = await backend.getCredential("deploy-user");
      expect(result.username).toBe("deploy-user");
    });

    it("should parse username from 'username:fingerprint' ref format", async () => {
      const result = await backend.getCredential("admin:SHA256:xyz789");
      expect(result.username).toBe("admin");
    });

    it("should throw on empty ref", async () => {
      await expect(backend.getCredential("")).rejects.toThrow(
        "Invalid ssh-agent ref",
      );
    });

    it("should throw on ref with empty username before colon", async () => {
      await expect(backend.getCredential(":SHA256:abc")).rejects.toThrow(
        "Username cannot be empty",
      );
    });
  });

  describe("getMetadata", () => {
    it("should return metadata with has_password false", async () => {
      const meta = await backend.getMetadata("admin");
      expect(meta.username).toBe("admin");
      expect(meta.has_password).toBe(false);
      expect(meta.backend).toBe("ssh-agent");
    });

    it("should never expose password in metadata", async () => {
      const meta = await backend.getMetadata("root:SHA256:abc123");
      expect((meta as Record<string, unknown>)["password"]).toBeUndefined();
      expect(meta.has_password).toBe(false);
    });

    it("should parse username from 'username:fingerprint' format", async () => {
      const meta = await backend.getMetadata("deploy:SHA256:fingerprint");
      expect(meta.username).toBe("deploy");
    });
  });

  describe("listIdentities", () => {
    it("should return identity list from ssh-add -l", async () => {
      process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
      (mockExecFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout:
          "2048 SHA256:abc123 user@laptop (RSA)\n4096 SHA256:def456 deploy-key (ED25519)\n",
        stderr: "",
      });

      const identities = await backend.listIdentities();
      expect(identities).toHaveLength(2);
      expect(identities[0]).toContain("SHA256:abc123");
      expect(identities[1]).toContain("SHA256:def456");
    });

    it("should return empty array when agent socket not available", async () => {
      delete process.env.SSH_AUTH_SOCK;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      const identities = await backend.listIdentities();
      expect(identities).toEqual([]);
    });

    it("should return empty array when ssh-add fails", async () => {
      process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
      (mockExecFile as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("agent refused"),
      );

      const identities = await backend.listIdentities();
      expect(identities).toEqual([]);
    });

    it("should never return private key material", async () => {
      process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
      (mockExecFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        stdout: "256 SHA256:abc123 mykey (ED25519)\n",
        stderr: "",
      });

      const identities = await backend.listIdentities();
      // Only fingerprints/comments — no BEGIN PRIVATE KEY
      for (const id of identities) {
        expect(id).not.toContain("PRIVATE KEY");
      }
    });
  });

  describe("cleanup", () => {
    it("should complete without error (no-op)", async () => {
      await expect(backend.cleanup()).resolves.toBeUndefined();
    });
  });
});
