import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MacOsKeychainBackend } from "../../src/credentials/macos-keychain.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../../src/utils/cli-resolver.js", () => ({
  resolveCliPath: vi.fn(() => "/usr/bin/security"),
}));

vi.mock("../../src/utils/platform.js", () => ({
  currentPlatform: vi.fn(() => "darwin"),
}));

import { execFile } from "child_process";
import { resolveCliPath } from "../../src/utils/cli-resolver.js";
import { currentPlatform } from "../../src/utils/platform.js";

function mockExecFile(stdout: string) {
  const mock = vi.mocked(execFile);
  mock.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, callback?: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (typeof _opts === "function") {
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
    (_cmd: unknown, _args: unknown, _opts: unknown, callback?: (err: Error | null, stdout: string, stderr: string) => void) => {
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

describe("MacOsKeychainBackend", () => {
  let backend: MacOsKeychainBackend;

  beforeEach(() => {
    backend = new MacOsKeychainBackend();
    vi.clearAllMocks();
    vi.mocked(resolveCliPath).mockReturnValue("/usr/bin/security");
    vi.mocked(currentPlatform).mockReturnValue("darwin");
  });

  afterEach(async () => {
    await backend.cleanup();
  });

  describe("name", () => {
    it("should be 'macos-keychain'", () => {
      expect(backend.name).toBe("macos-keychain");
    });
  });

  describe("isAvailable", () => {
    it("should return true on macOS with security CLI", async () => {
      expect(await backend.isAvailable()).toBe(true);
    });

    it("should return false on non-macOS platforms", async () => {
      vi.mocked(currentPlatform).mockReturnValue("linux");
      expect(await backend.isAvailable()).toBe(false);
    });

    it("should return false when security CLI not found", async () => {
      vi.mocked(resolveCliPath).mockImplementation(() => {
        throw new Error("CLI tool not found: security");
      });
      expect(await backend.isAvailable()).toBe(false);
    });
  });

  describe("getCredential", () => {
    it("should return account name as username and password from keychain", async () => {
      mockExecFile("keychain-password\n");

      const result = await backend.getCredential("my-service:my-account");
      expect(result.username).toBe("my-account");
      expect(Buffer.isBuffer(result.password)).toBe(true);
      expect(result.password.toString("utf-8")).toBe("keychain-password");
    });

    it("should call security CLI with correct args", async () => {
      mockExecFile("pass\n");

      await backend.getCredential("sshservice:admin");

      const mock = vi.mocked(execFile);
      const args = mock.mock.calls[0][1] as string[];
      expect(args).toEqual([
        "find-generic-password",
        "-s",
        "sshservice",
        "-a",
        "admin",
        "-w",
      ]);
    });

    it("should throw on invalid ref format (no colon)", async () => {
      await expect(
        backend.getCredential("no-colon"),
      ).rejects.toThrow("Invalid macOS Keychain ref format");
    });

    it("should throw on invalid ref format (empty service)", async () => {
      await expect(
        backend.getCredential(":account"),
      ).rejects.toThrow("Invalid macOS Keychain ref format");
    });

    it("should throw on invalid ref format (empty account)", async () => {
      await expect(
        backend.getCredential("service:"),
      ).rejects.toThrow("Invalid macOS Keychain ref format");
    });
  });

  describe("getMetadata", () => {
    it("should return metadata with has_password true when item found", async () => {
      mockExecFile("keychain: ...\n");

      const meta = await backend.getMetadata("my-service:my-account");
      expect(meta.username).toBe("my-account");
      expect(meta.has_password).toBe(true);
      expect(meta.backend).toBe("macos-keychain");
    });

    it("should return has_password false when item not found", async () => {
      mockExecFileError("The specified item could not be found");

      const meta = await backend.getMetadata("missing:account");
      expect(meta.has_password).toBe(false);
    });
  });

  describe("cleanup", () => {
    it("should zero-fill all staged password Buffers", async () => {
      mockExecFile("password123\n");

      const result = await backend.getCredential("svc:acct");
      const pwRef = result.password;

      await backend.cleanup();
      expect(pwRef.every((byte) => byte === 0)).toBe(true);
    });
  });
});
