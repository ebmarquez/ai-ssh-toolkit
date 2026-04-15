import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BitwardenBackend } from "../../src/credentials/bitwarden.js";

// Mock child_process and cli-resolver
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../../src/utils/cli-resolver.js", () => ({
  resolveCliPath: vi.fn(() => "/usr/bin/bw"),
}));

import { execFile } from "child_process";
import { resolveCliPath } from "../../src/utils/cli-resolver.js";

// Helper to make execFile mock resolve with stdout
function mockExecFile(stdout: string) {
  const mock = vi.mocked(execFile);
  mock.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, callback?: Function) => {
      if (typeof _opts === "function") {
        // callback in 3rd position (no opts)
        _opts(null, stdout, "");
      } else if (callback) {
        callback(null, stdout, "");
      }
      return {} as ReturnType<typeof execFile>;
    },
  );
}

function mockExecFileError(message: string) {
  const mock = vi.mocked(execFile);
  mock.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, callback?: Function) => {
      const err = new Error(message);
      if (typeof _opts === "function") {
        _opts(err, "", "");
      } else if (callback) {
        callback(err, "", "");
      }
      return {} as ReturnType<typeof execFile>;
    },
  );
}

describe("BitwardenBackend", () => {
  let backend: BitwardenBackend;

  beforeEach(() => {
    backend = new BitwardenBackend();
    vi.clearAllMocks();
    // Restore default mock — resolveCliPath returns a valid path
    vi.mocked(resolveCliPath).mockReturnValue("/usr/bin/bw");
  });

  afterEach(async () => {
    await backend.cleanup();
  });

  describe("name", () => {
    it("should be 'bitwarden'", () => {
      expect(backend.name).toBe("bitwarden");
    });
  });

  describe("isAvailable", () => {
    it("should return true when vault is unlocked", async () => {
      mockExecFile(JSON.stringify({ status: "unlocked" }));
      expect(await backend.isAvailable()).toBe(true);
    });

    it("should return false when vault is locked", async () => {
      mockExecFile(JSON.stringify({ status: "locked" }));
      expect(await backend.isAvailable()).toBe(false);
    });

    it("should return false when vault is unauthenticated", async () => {
      mockExecFile(JSON.stringify({ status: "unauthenticated" }));
      expect(await backend.isAvailable()).toBe(false);
    });

    it("should return false when bw CLI not found", async () => {
      vi.mocked(resolveCliPath).mockImplementation(() => {
        throw new Error("CLI tool not found: bw");
      });
      expect(await backend.isAvailable()).toBe(false);
    });

    it("should return false when bw status command fails", async () => {
      mockExecFileError("Command failed");
      expect(await backend.isAvailable()).toBe(false);
    });
  });

  describe("getCredential", () => {
    it("should return username and password Buffer from BW item", async () => {
      const bwItem = {
        login: {
          username: "admin",
          password: "sup3r-s3cret",
        },
      };
      mockExecFile(JSON.stringify(bwItem));

      const result = await backend.getCredential("switch-admin");
      expect(result.username).toBe("admin");
      expect(Buffer.isBuffer(result.password)).toBe(true);
      expect(result.password.toString("utf-8")).toBe("sup3r-s3cret");
    });

    it("should throw if item has no login field", async () => {
      mockExecFile(JSON.stringify({ name: "some-note" }));

      await expect(backend.getCredential("some-note")).rejects.toThrow(
        'has no login credentials',
      );
    });

    it("should handle missing password gracefully", async () => {
      const bwItem = {
        login: { username: "admin", password: null },
      };
      mockExecFile(JSON.stringify(bwItem));

      const result = await backend.getCredential("no-pass-item");
      expect(result.username).toBe("admin");
      expect(result.password.toString("utf-8")).toBe("");
    });

    it("should handle missing username gracefully", async () => {
      const bwItem = {
        login: { username: null, password: "secret" },
      };
      mockExecFile(JSON.stringify(bwItem));

      const result = await backend.getCredential("no-user-item");
      expect(result.username).toBe("");
      expect(result.password.toString("utf-8")).toBe("secret");
    });

    it("should resolve CLI path via resolveCliPath", async () => {
      const bwItem = { login: { username: "u", password: "p" } };
      mockExecFile(JSON.stringify(bwItem));

      await backend.getCredential("test");
      expect(resolveCliPath).toHaveBeenCalledWith("bw");
    });
  });

  describe("getMetadata", () => {
    it("should return metadata without password value", async () => {
      const bwItem = {
        login: { username: "admin", password: "secret" },
      };
      mockExecFile(JSON.stringify(bwItem));

      const meta = await backend.getMetadata("switch-admin");
      expect(meta.username).toBe("admin");
      expect(meta.has_password).toBe(true);
      expect(meta.backend).toBe("bitwarden");
      expect((meta as Record<string, unknown>)["password"]).toBeUndefined();
    });

    it("should report has_password false when no password", async () => {
      const bwItem = { login: { username: "admin", password: "" } };
      mockExecFile(JSON.stringify(bwItem));

      const meta = await backend.getMetadata("test");
      expect(meta.has_password).toBe(false);
    });
  });

  describe("session key management", () => {
    it("should include --session flag when session key is set", async () => {
      backend.setSessionKey("test-session-key-123");
      const bwItem = { login: { username: "u", password: "p" } };
      mockExecFile(JSON.stringify(bwItem));

      await backend.getCredential("test");

      const mock = vi.mocked(execFile);
      const callArgs = mock.mock.calls[0];
      const args = callArgs[1] as string[];
      expect(args).toContain("--session");
      expect(args).toContain("test-session-key-123");
    });

    it("should not include --session flag when no session key", async () => {
      const bwItem = { login: { username: "u", password: "p" } };
      mockExecFile(JSON.stringify(bwItem));

      await backend.getCredential("test");

      const mock = vi.mocked(execFile);
      const callArgs = mock.mock.calls[0];
      const args = callArgs[1] as string[];
      expect(args).not.toContain("--session");
    });
  });

  describe("cleanup", () => {
    it("should zero-fill all staged password Buffers", async () => {
      const bwItem = { login: { username: "u", password: "password123" } };
      mockExecFile(JSON.stringify(bwItem));

      const result = await backend.getCredential("test");
      const pwRef = result.password;
      expect(pwRef.toString("utf-8")).toBe("password123");

      await backend.cleanup();

      // Buffer should be zero-filled
      expect(pwRef.every((byte) => byte === 0)).toBe(true);
    });

    it("should zero-fill multiple staged Buffers", async () => {
      const item1 = { login: { username: "u1", password: "pass1" } };
      const item2 = { login: { username: "u2", password: "pass2" } };

      mockExecFile(JSON.stringify(item1));
      const r1 = await backend.getCredential("item1");

      mockExecFile(JSON.stringify(item2));
      const r2 = await backend.getCredential("item2");

      await backend.cleanup();

      expect(r1.password.every((byte) => byte === 0)).toBe(true);
      expect(r2.password.every((byte) => byte === 0)).toBe(true);
    });
  });

  describe("security: --raw flag", () => {
    it("should always include --raw in bw CLI args", async () => {
      const bwItem = { login: { username: "u", password: "p" } };
      mockExecFile(JSON.stringify(bwItem));

      await backend.getCredential("test");

      const mock = vi.mocked(execFile);
      const callArgs = mock.mock.calls[0];
      const args = callArgs[1] as string[];
      expect(args).toContain("--raw");
    });
  });
});
