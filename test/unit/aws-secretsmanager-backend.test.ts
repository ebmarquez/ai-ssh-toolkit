import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AwsSecretsManagerBackend } from "../../src/credentials/aws-secretsmanager.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../../src/utils/cli-resolver.js", () => ({
  resolveCliPath: vi.fn(() => "/usr/bin/aws"),
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

describe("AwsSecretsManagerBackend", () => {
  let backend: AwsSecretsManagerBackend;

  beforeEach(() => {
    backend = new AwsSecretsManagerBackend();
    vi.clearAllMocks();
    vi.mocked(resolveCliPath).mockReturnValue("/usr/bin/aws");
  });

  afterEach(async () => {
    await backend.cleanup();
  });

  describe("name", () => {
    it("should be 'aws-secretsmanager'", () => {
      expect(backend.name).toBe("aws-secretsmanager");
    });
  });

  describe("isAvailable", () => {
    it("should return true when AWS credentials are valid", async () => {
      mockExecFile('{"Account":"123456789012"}');
      expect(await backend.isAvailable()).toBe(true);
    });

    it("should return false when aws CLI not found", async () => {
      vi.mocked(resolveCliPath).mockImplementation(() => {
        throw new Error("CLI tool not found: aws");
      });
      expect(await backend.isAvailable()).toBe(false);
    });

    it("should return false when AWS credentials invalid", async () => {
      mockExecFileError("Unable to locate credentials");
      expect(await backend.isAvailable()).toBe(false);
    });
  });

  describe("getCredential", () => {
    it("should return username and password from AWS secret", async () => {
      const awsResponse = {
        SecretString: JSON.stringify({
          username: "dbadmin",
          password: "aws-secret-pass",
        }),
      };
      mockExecFileSequence([
        { stdout: JSON.stringify(awsResponse) },
      ]);

      const result = await backend.getCredential(
        "my-db-secret#username:password",
      );
      expect(result.username).toBe("dbadmin");
      expect(Buffer.isBuffer(result.password)).toBe(true);
      expect(result.password.toString("utf-8")).toBe("aws-secret-pass");
    });

    it("should support ARN format refs", async () => {
      const awsResponse = {
        SecretString: JSON.stringify({
          user: "root",
          pass: "arn-secret",
        }),
      };
      mockExecFile(JSON.stringify(awsResponse));

      const result = await backend.getCredential(
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret#user:pass",
      );
      expect(result.username).toBe("root");
      expect(result.password.toString("utf-8")).toBe("arn-secret");

      // Verify the secret-id passed to CLI
      const mock = vi.mocked(execFile);
      const args = mock.mock.calls[0][1] as string[];
      expect(args).toContain(
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret",
      );
    });

    it("should throw on invalid ref format (no hash)", async () => {
      await expect(
        backend.getCredential("my-secret"),
      ).rejects.toThrow("Invalid AWS Secrets Manager ref format");
    });

    it("should throw on invalid ref format (no colon in keys)", async () => {
      await expect(
        backend.getCredential("my-secret#fieldonly"),
      ).rejects.toThrow("Invalid AWS Secrets Manager ref format");
    });

    it("should call aws CLI with correct args", async () => {
      const awsResponse = {
        SecretString: JSON.stringify({ u: "x", p: "y" }),
      };
      mockExecFile(JSON.stringify(awsResponse));

      await backend.getCredential("prod/db-creds#u:p");

      const mock = vi.mocked(execFile);
      const args = mock.mock.calls[0][1] as string[];
      expect(args).toEqual([
        "secretsmanager",
        "get-secret-value",
        "--secret-id",
        "prod/db-creds",
        "--output",
        "json",
      ]);
    });
  });

  describe("getMetadata", () => {
    it("should return metadata without password value", async () => {
      const awsResponse = {
        SecretString: JSON.stringify({
          username: "admin",
          password: "secret",
        }),
      };
      mockExecFile(JSON.stringify(awsResponse));

      const meta = await backend.getMetadata("my-secret#username:password");
      expect(meta.username).toBe("admin");
      expect(meta.has_password).toBe(true);
      expect(meta.backend).toBe("aws-secretsmanager");
    });

    it("should report has_password false when key missing", async () => {
      const awsResponse = {
        SecretString: JSON.stringify({ username: "admin" }),
      };
      mockExecFile(JSON.stringify(awsResponse));

      const meta = await backend.getMetadata("my-secret#username:password");
      expect(meta.has_password).toBe(false);
    });
  });

  describe("cleanup", () => {
    it("should zero-fill all staged password Buffers", async () => {
      const awsResponse = {
        SecretString: JSON.stringify({ u: "x", p: "password123" }),
      };
      mockExecFile(JSON.stringify(awsResponse));

      const result = await backend.getCredential("secret#u:p");
      const pwRef = result.password;

      await backend.cleanup();
      expect(pwRef.every((byte) => byte === 0)).toBe(true);
    });
  });
});
