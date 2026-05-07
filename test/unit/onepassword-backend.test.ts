import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OnePasswordBackend } from "../../src/credentials/onepassword.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../../src/utils/cli-resolver.js", () => ({
  resolveCliPath: vi.fn(() => "/usr/bin/op"),
}));

import { execFile } from "child_process";
import { resolveCliPath } from "../../src/utils/cli-resolver.js";

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

function mockExecFileSequence(responses: Array<{ stdout?: string; error?: string }>) {
  const mock = vi.mocked(execFile);
  let callIdx = 0;
  mock.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, callback?: (err: Error | null, stdout: string, stderr: string) => void) => {
      const resp = responses[callIdx++] ?? responses[responses.length - 1];
      const cb = typeof _opts === "function" ? _opts : callback;
      if (resp.error) {
        cb?.(new Error(resp.error), "", "");
      } else {
        cb?.(null, resp.stdout ?? "", "");
      }
      return {} as ReturnType<typeof execFile>;
    },
  );
}

describe("OnePasswordBackend", () => {
  let backend: OnePasswordBackend;

  beforeEach(() => {
    backend = new OnePasswordBackend();
    vi.clearAllMocks();
    vi.mocked(resolveCliPath).mockReturnValue("/usr/bin/op");
  });

  afterEach(async () => {
    await backend.cleanup();
  });

  describe("name", () => {
    it("should be 'onepassword'", () => {
      expect(backend.name).toBe("onepassword");
    });
  });

  describe("isAvailable", () => {
    it("should return true when op CLI is available and signed in", async () => {
      mockExecFile('{"email":"user@example.com"}');
      expect(await backend.isAvailable()).toBe(true);
    });

    it("should return false when op CLI not found", async () => {
      vi.mocked(resolveCliPath).mockImplementation(() => {
        throw new Error("CLI tool not found: op");
      });
      expect(await backend.isAvailable()).toBe(false);
    });

    it("should return false when op whoami fails", async () => {
      mockExecFileError("not signed in");
      expect(await backend.isAvailable()).toBe(false);
    });
  });

  describe("getCredential", () => {
    it("should return username and password from 1Password", async () => {
      mockExecFileSequence([
        { stdout: "admin\n" },
        { stdout: "s3cret-pass\n" },
      ]);

      const result = await backend.getCredential(
        "op://vault/item/username:password",
      );
      expect(result.username).toBe("admin");
      expect(Buffer.isBuffer(result.password)).toBe(true);
      expect(result.password.toString("utf-8")).toBe("s3cret-pass");
    });

    it("should call op read with correct field refs", async () => {
      mockExecFileSequence([
        { stdout: "user1\n" },
        { stdout: "pass1\n" },
      ]);

      await backend.getCredential("op://myvault/myitem/user:pass");

      const mock = vi.mocked(execFile);
      const call1Args = mock.mock.calls[0][1] as string[];
      const call2Args = mock.mock.calls[1][1] as string[];
      expect(call1Args).toEqual(["read", "op://myvault/myitem/user"]);
      expect(call2Args).toEqual(["read", "op://myvault/myitem/pass"]);
    });

    it("should throw on invalid ref format (no colon)", async () => {
      await expect(
        backend.getCredential("op://vault/item/field"),
      ).rejects.toThrow("Invalid 1Password ref format");
    });

    it("should throw on invalid ref format (empty parts)", async () => {
      await expect(
        backend.getCredential("op://vault/item/:"),
      ).rejects.toThrow("Invalid 1Password ref format");
    });
  });

  describe("getMetadata", () => {
    it("should return metadata without password value", async () => {
      mockExecFile("admin");

      const meta = await backend.getMetadata(
        "op://vault/item/username:password",
      );
      expect(meta.username).toBe("admin");
      expect(meta.has_password).toBe(true);
      expect(meta.backend).toBe("onepassword");
    });
  });

  describe("cleanup", () => {
    it("should zero-fill all staged password Buffers", async () => {
      mockExecFileSequence([
        { stdout: "user\n" },
        { stdout: "password123\n" },
      ]);

      const result = await backend.getCredential(
        "op://vault/item/user:pass",
      );
      const pwRef = result.password;
      expect(pwRef.toString("utf-8")).toBe("password123");

      await backend.cleanup();
      expect(pwRef.every((byte) => byte === 0)).toBe(true);
    });
  });
});
