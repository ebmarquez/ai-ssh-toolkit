import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AzureKeyVaultBackend } from "../../src/credentials/azure-keyvault.js";

// Mock child_process and cli-resolver
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../../src/utils/cli-resolver.js", () => ({
  resolveCliPath: vi.fn(() => "/usr/bin/az"),
}));

import { execFile } from "child_process";
import { resolveCliPath } from "../../src/utils/cli-resolver.js";

function mockExecFileSequence(responses: Array<{ stdout?: string; error?: Error }>) {
  const mock = vi.mocked(execFile);
  let callIndex = 0;
  mock.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, callback?: (err: Error | null, stdout: string, stderr: string) => void) => {
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      const cb = typeof _opts === "function" ? _opts : callback;
      if (response.error) {
        cb?.(response.error, "", "");
      } else {
        cb?.(null, response.stdout ?? "", "");
      }
      return {} as ReturnType<typeof execFile>;
    },
  );
}

function mockExecFile(stdout: string) {
  mockExecFileSequence([{ stdout }]);
}

function mockExecFileError(message: string) {
  mockExecFileSequence([{ error: new Error(message) }]);
}

describe("AzureKeyVaultBackend", () => {
  let backend: AzureKeyVaultBackend;

  beforeEach(() => {
    backend = new AzureKeyVaultBackend();
    vi.clearAllMocks();
    vi.mocked(resolveCliPath).mockReturnValue("/usr/bin/az");
  });

  afterEach(async () => {
    await backend.cleanup();
  });

  describe("name", () => {
    it("should be 'azure-keyvault'", () => {
      expect(backend.name).toBe("azure-keyvault");
    });
  });

  describe("isAvailable", () => {
    it("should return true when az CLI is authenticated", async () => {
      mockExecFile(JSON.stringify({ name: "my-sub", state: "Enabled" }));
      expect(await backend.isAvailable()).toBe(true);
    });

    it("should return false when az CLI not found", async () => {
      vi.mocked(resolveCliPath).mockImplementation(() => {
        throw new Error("CLI tool not found: az");
      });
      expect(await backend.isAvailable()).toBe(false);
    });

    it("should return false when az account show fails", async () => {
      mockExecFileError("Please run az login");
      expect(await backend.isAvailable()).toBe(false);
    });
  });

  describe("ref format validation", () => {
    it("should throw on ref without slash", async () => {
      await expect(backend.getCredential("no-slash")).rejects.toThrow(
        'Invalid Azure KV ref format',
      );
    });

    it("should throw on ref starting with slash", async () => {
      await expect(backend.getCredential("/secret")).rejects.toThrow(
        'Invalid Azure KV ref format',
      );
    });

    it("should throw on ref ending with slash", async () => {
      await expect(backend.getCredential("vault/")).rejects.toThrow(
        'Invalid Azure KV ref format',
      );
    });
  });

  describe("getCredential — single JSON secret", () => {
    it("should parse JSON secret with username/password", async () => {
      const jsonSecret = JSON.stringify({ username: "admin", password: "vault-pass" });
      mockExecFile(jsonSecret + "\n");

      const result = await backend.getCredential("my-vault/switch-creds");
      expect(result.username).toBe("admin");
      expect(Buffer.isBuffer(result.password)).toBe(true);
      expect(result.password.toString("utf-8")).toBe("vault-pass");
    });

    it("should treat plain string as password-only", async () => {
      mockExecFile("plain-password-value\n");

      const result = await backend.getCredential("my-vault/plain-secret");
      expect(result.username).toBe("");
      expect(result.password.toString("utf-8")).toBe("plain-password-value");
    });
  });

  describe("getCredential — split user:pass secrets", () => {
    it("should fetch separate user and pass secrets", async () => {
      // Two sequential az keyvault secret show calls
      mockExecFileSequence([
        { stdout: "admin-user\n" },   // user secret
        { stdout: "admin-pass\n" },   // pass secret
      ]);

      const result = await backend.getCredential("my-vault/user-secret:pass-secret");
      expect(result.username).toBe("admin-user");
      expect(result.password.toString("utf-8")).toBe("admin-pass");
    });
  });

  describe("getMetadata", () => {
    it("should return metadata when secret exists", async () => {
      mockExecFile("my-secret\n");

      const meta = await backend.getMetadata("my-vault/my-secret");
      expect(meta.has_password).toBe(true);
      expect(meta.backend).toBe("azure-keyvault");
      expect((meta as Record<string, unknown>)["password"]).toBeUndefined();
    });

    it("should return has_password false when secret not found", async () => {
      mockExecFileError("Secret not found");

      const meta = await backend.getMetadata("my-vault/missing");
      expect(meta.has_password).toBe(false);
      expect(meta.backend).toBe("azure-keyvault");
    });
  });

  describe("cleanup", () => {
    it("should zero-fill all staged Buffers", async () => {
      const jsonSecret = JSON.stringify({ username: "u", password: "secret" });
      mockExecFile(jsonSecret + "\n");

      const result = await backend.getCredential("vault/cred");
      const pwRef = result.password;
      expect(pwRef.toString("utf-8")).toBe("secret");

      await backend.cleanup();
      expect(pwRef.every((byte) => byte === 0)).toBe(true);
    });
  });

  describe("security: CLI path resolution", () => {
    it("should resolve az CLI to absolute path", async () => {
      mockExecFile(JSON.stringify({ name: "sub" }));
      await backend.isAvailable();
      expect(resolveCliPath).toHaveBeenCalledWith("az");
    });
  });
});
