import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EnvCredentialBackend } from "../../src/credentials/env.js";

describe("EnvCredentialBackend", () => {
  let backend: EnvCredentialBackend;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    backend = new EnvCredentialBackend();
    // Save and set test env vars
    savedEnv["TEST_USER"] = process.env["TEST_USER"];
    savedEnv["TEST_PASS"] = process.env["TEST_PASS"];
    process.env["TEST_USER"] = "admin";
    process.env["TEST_PASS"] = "s3cret!";
  });

  afterEach(async () => {
    await backend.cleanup();
    // Restore original env
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  describe("name", () => {
    it("should be 'env'", () => {
      expect(backend.name).toBe("env");
    });
  });

  describe("isAvailable", () => {
    it("should always return true", async () => {
      expect(await backend.isAvailable()).toBe(true);
    });
  });

  describe("getCredential", () => {
    it("should return username and password from env vars", async () => {
      const result = await backend.getCredential("TEST_USER:TEST_PASS");
      expect(result.username).toBe("admin");
      expect(Buffer.isBuffer(result.password)).toBe(true);
      expect(result.password.toString("utf-8")).toBe("s3cret!");
    });

    it("should return password as Buffer (not string)", async () => {
      const result = await backend.getCredential("TEST_USER:TEST_PASS");
      expect(result.password).toBeInstanceOf(Buffer);
    });

    it("should throw if user env var is not set", async () => {
      delete process.env["TEST_USER"];
      await expect(
        backend.getCredential("TEST_USER:TEST_PASS"),
      ).rejects.toThrow("Environment variable not set: TEST_USER");
    });

    it("should throw if password env var is not set", async () => {
      delete process.env["TEST_PASS"];
      await expect(
        backend.getCredential("TEST_USER:TEST_PASS"),
      ).rejects.toThrow("Environment variable not set: TEST_PASS");
    });

    it("should throw on invalid ref format (no colon)", async () => {
      await expect(backend.getCredential("SINGLE_VAR")).rejects.toThrow(
        'Invalid env ref format',
      );
    });

    it("should throw on invalid ref format (empty parts)", async () => {
      await expect(backend.getCredential(":TEST_PASS")).rejects.toThrow(
        'Invalid env ref format',
      );
      await expect(backend.getCredential("TEST_USER:")).rejects.toThrow(
        'Invalid env ref format',
      );
    });

    it("should handle special characters in password", async () => {
      process.env["TEST_PASS"] = 'p@$$w0rd!#%&*"';
      const result = await backend.getCredential("TEST_USER:TEST_PASS");
      expect(result.password.toString("utf-8")).toBe('p@$$w0rd!#%&*"');
    });

    it("should handle unicode in credentials", async () => {
      process.env["TEST_USER"] = "管理者";
      process.env["TEST_PASS"] = "パスワード";
      const result = await backend.getCredential("TEST_USER:TEST_PASS");
      expect(result.username).toBe("管理者");
      expect(result.password.toString("utf-8")).toBe("パスワード");
    });
  });

  describe("getMetadata", () => {
    it("should return metadata without exposing password", async () => {
      const meta = await backend.getMetadata("TEST_USER:TEST_PASS");
      expect(meta.username).toBe("admin");
      expect(meta.has_password).toBe(true);
      expect(meta.backend).toBe("env");
      expect((meta as Record<string, unknown>)["password"]).toBeUndefined();
    });

    it("should return has_password false if pass var missing", async () => {
      delete process.env["TEST_PASS"];
      const meta = await backend.getMetadata("TEST_USER:TEST_PASS");
      expect(meta.has_password).toBe(false);
    });

    it("should return empty username if user var missing", async () => {
      delete process.env["TEST_USER"];
      const meta = await backend.getMetadata("TEST_USER:TEST_PASS");
      expect(meta.username).toBe("");
    });
  });

  describe("cleanup", () => {
    it("should complete without error", async () => {
      await expect(backend.cleanup()).resolves.toBeUndefined();
    });
  });

  describe("security: Buffer password lifecycle", () => {
    it("password Buffer can be zero-filled after use", async () => {
      const result = await backend.getCredential("TEST_USER:TEST_PASS");
      const pw = result.password;
      expect(pw.toString("utf-8")).toBe("s3cret!");

      // Zero-fill — simulates post-use cleanup
      pw.fill(0);
      expect(pw.toString("utf-8")).toBe("\0".repeat(pw.length));
    });
  });
});
