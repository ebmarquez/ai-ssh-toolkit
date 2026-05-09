import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HashiCorpVaultBackend } from "../../src/credentials/hashicorp-vault.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../../src/utils/cli-resolver.js", () => ({
  resolveCliPath: vi.fn(() => "/usr/bin/vault"),
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

describe("HashiCorpVaultBackend", () => {
  let backend: HashiCorpVaultBackend;
  const origEnv = { ...process.env };

  beforeEach(() => {
    backend = new HashiCorpVaultBackend();
    vi.clearAllMocks();
    vi.mocked(resolveCliPath).mockReturnValue("/usr/bin/vault");
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "test-token";
  });

  afterEach(async () => {
    await backend.cleanup();
    process.env = { ...origEnv };
  });

  describe("name", () => {
    it("should be 'hashicorp-vault'", () => {
      expect(backend.name).toBe("hashicorp-vault");
    });
  });

  describe("isAvailable", () => {
    it("should return true when VAULT_ADDR set and token valid", async () => {
      mockExecFile('{"data":{"accessor":"token-accessor"}}');
      expect(await backend.isAvailable()).toBe(true);
    });

    it("should return false when VAULT_ADDR not set", async () => {
      delete process.env.VAULT_ADDR;
      expect(await backend.isAvailable()).toBe(false);
    });

    it("should return false when vault CLI not found", async () => {
      vi.mocked(resolveCliPath).mockImplementation(() => {
        throw new Error("CLI tool not found: vault");
      });
      expect(await backend.isAvailable()).toBe(false);
    });

    it("should return false when token lookup fails", async () => {
      mockExecFileError("permission denied");
      expect(await backend.isAvailable()).toBe(false);
    });
  });

  describe("getCredential", () => {
    it("should return username and password from Vault KV", async () => {
      const vaultResponse = {
        data: {
          data: {
            user: "admin",
            pass: "vault-secret",
          },
        },
      };
      mockExecFileSequence([
        { stdout: JSON.stringify(vaultResponse) },
      ]);

      const result = await backend.getCredential("secret/myapp#user:pass");
      expect(result.username).toBe("admin");
      expect(Buffer.isBuffer(result.password)).toBe(true);
      expect(result.password.toString("utf-8")).toBe("vault-secret");
    });

    it("should handle KV v1 format (data without nested data)", async () => {
      const vaultResponse = {
        data: {
          username: "root",
          password: "kv1-secret",
        },
      };
      mockExecFile(JSON.stringify(vaultResponse));

      const result = await backend.getCredential(
        "secret/data/myapp#username:password",
      );
      expect(result.username).toBe("root");
      expect(result.password.toString("utf-8")).toBe("kv1-secret");
    });

    it("should throw on invalid ref format (no hash)", async () => {
      await expect(
        backend.getCredential("secret/path"),
      ).rejects.toThrow("Invalid Vault ref format");
    });

    it("should throw on invalid ref format (no colon in fields)", async () => {
      await expect(
        backend.getCredential("secret/path#fieldonly"),
      ).rejects.toThrow("Invalid Vault ref format");
    });

    it("should throw on empty parts", async () => {
      await expect(
        backend.getCredential("#user:pass"),
      ).rejects.toThrow("Invalid Vault ref format");
    });

    it("should call vault CLI with correct args", async () => {
      const vaultResponse = {
        data: { data: { u: "x", p: "y" } },
      };
      mockExecFile(JSON.stringify(vaultResponse));

      await backend.getCredential("secret/ssh-creds#u:p");

      const mock = vi.mocked(execFile);
      const args = mock.mock.calls[0][1] as string[];
      expect(args).toEqual(["kv", "get", "-format=json", "secret/ssh-creds"]);
    });
  });

  describe("getMetadata", () => {
    it("should return metadata without password value", async () => {
      const vaultResponse = {
        data: {
          data: { user: "admin", pass: "secret" },
        },
      };
      mockExecFile(JSON.stringify(vaultResponse));

      const meta = await backend.getMetadata("secret/app#user:pass");
      expect(meta.username).toBe("admin");
      expect(meta.has_password).toBe(true);
      expect(meta.backend).toBe("hashicorp-vault");
    });

    it("should report has_password false when field missing", async () => {
      const vaultResponse = {
        data: {
          data: { user: "admin" },
        },
      };
      mockExecFile(JSON.stringify(vaultResponse));

      const meta = await backend.getMetadata("secret/app#user:pass");
      expect(meta.has_password).toBe(false);
    });
  });

  describe("cleanup", () => {
    it("should zero-fill all staged password Buffers", async () => {
      const vaultResponse = {
        data: { data: { u: "admin", p: "password123" } },
      };
      mockExecFile(JSON.stringify(vaultResponse));

      const result = await backend.getCredential("secret/app#u:p");
      const pwRef = result.password;

      await backend.cleanup();
      expect(pwRef.every((byte) => byte === 0)).toBe(true);
    });
  });
});
