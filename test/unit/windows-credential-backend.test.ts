import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WindowsCredentialBackend } from "../../src/credentials/windows-credential.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../../src/utils/platform.js", () => ({
  currentPlatform: vi.fn(() => "win32"),
}));

import { execFile } from "child_process";
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

describe("WindowsCredentialBackend", () => {
  let backend: WindowsCredentialBackend;

  beforeEach(() => {
    backend = new WindowsCredentialBackend();
    vi.clearAllMocks();
    vi.mocked(currentPlatform).mockReturnValue("win32");
  });

  afterEach(async () => {
    await backend.cleanup();
  });

  describe("name", () => {
    it("should be 'windows-credential'", () => {
      expect(backend.name).toBe("windows-credential");
    });
  });

  describe("isAvailable", () => {
    it("should return true on Windows with cmdkey", async () => {
      mockExecFile("Currently stored credentials:\n");
      expect(await backend.isAvailable()).toBe(true);
    });

    it("should return false on non-Windows platforms", async () => {
      vi.mocked(currentPlatform).mockReturnValue("linux");
      expect(await backend.isAvailable()).toBe(false);
    });

    it("should return false when cmdkey fails", async () => {
      mockExecFileError("cmdkey not found");
      expect(await backend.isAvailable()).toBe(false);
    });
  });

  describe("getCredential", () => {
    it("should return username and password from Windows Credential Manager", async () => {
      mockExecFile("DOMAIN\\admin|win-secret\n");

      const result = await backend.getCredential("my-target");
      expect(result.username).toBe("DOMAIN\\admin");
      expect(Buffer.isBuffer(result.password)).toBe(true);
      expect(result.password.toString("utf-8")).toBe("win-secret");
    });

    it("should throw on empty ref", async () => {
      await expect(backend.getCredential("")).rejects.toThrow(
        "Invalid Windows Credential ref",
      );
    });

    it("should throw on whitespace-only ref", async () => {
      await expect(backend.getCredential("   ")).rejects.toThrow(
        "Invalid Windows Credential ref",
      );
    });

    it("should call powershell with correct arguments", async () => {
      mockExecFile("user|pass\n");

      await backend.getCredential("my-target");

      const mock = vi.mocked(execFile);
      const cmd = mock.mock.calls[0][0] as string;
      const args = mock.mock.calls[0][1] as string[];
      expect(cmd).toBe("powershell");
      expect(args[0]).toBe("-NoProfile");
      expect(args[1]).toBe("-NonInteractive");
      expect(args[2]).toBe("-Command");
    });
  });

  describe("getMetadata", () => {
    it("should return has_password true when target found in cmdkey list", async () => {
      mockExecFile("Currently stored credentials:\n  Target: my-target\n");

      const meta = await backend.getMetadata("my-target");
      expect(meta.has_password).toBe(true);
      expect(meta.backend).toBe("windows-credential");
    });

    it("should return has_password false when target not found", async () => {
      mockExecFile("Currently stored credentials:\n  Target: other-target\n");

      const meta = await backend.getMetadata("my-target");
      expect(meta.has_password).toBe(false);
    });

    it("should return has_password false when cmdkey fails", async () => {
      mockExecFileError("cmdkey error");

      const meta = await backend.getMetadata("my-target");
      expect(meta.has_password).toBe(false);
    });
  });

  describe("cleanup", () => {
    it("should zero-fill all staged password Buffers", async () => {
      mockExecFile("user|password123\n");

      const result = await backend.getCredential("test-target");
      const pwRef = result.password;

      await backend.cleanup();
      expect(pwRef.every((byte) => byte === 0)).toBe(true);
    });
  });
});
