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

  describe("parseRef", () => {
    describe("single variable (password-only)", () => {
      it("should parse a bare variable name", () => {
        const result = backend.parseRef("TEST_PASS");
        expect(result).toEqual({ userVar: undefined, passVar: "TEST_PASS" });
      });

      it("should trim whitespace", () => {
        const result = backend.parseRef("  TEST_PASS  ");
        expect(result).toEqual({ userVar: undefined, passVar: "TEST_PASS" });
      });
    });

    describe("named-key format", () => {
      it("should parse user=X,pass=Y", () => {
        const result = backend.parseRef("user=TEST_USER,pass=TEST_PASS");
        expect(result).toEqual({ userVar: "TEST_USER", passVar: "TEST_PASS" });
      });

      it("should parse pass=Y,user=X (reversed order)", () => {
        const result = backend.parseRef("pass=TEST_PASS,user=TEST_USER");
        expect(result).toEqual({ userVar: "TEST_USER", passVar: "TEST_PASS" });
      });

      it("should parse pass=Y alone (no user key)", () => {
        const result = backend.parseRef("pass=TEST_PASS");
        expect(result).toEqual({ userVar: undefined, passVar: "TEST_PASS" });
      });

      it("should be case-insensitive for keys", () => {
        const result = backend.parseRef("User=TEST_USER,Pass=TEST_PASS");
        expect(result).toEqual({ userVar: "TEST_USER", passVar: "TEST_PASS" });
      });

      it("should throw on missing pass key", () => {
        expect(() => backend.parseRef("user=TEST_USER")).toThrow(
          'Missing required "pass" key',
        );
      });

      it("should throw on unknown key", () => {
        expect(() => backend.parseRef("pass=P,host=H")).toThrow(
          'Unknown key "host"',
        );
      });

      it("should throw on empty value", () => {
        expect(() => backend.parseRef("user=,pass=TEST_PASS")).toThrow(
          "Empty key or value",
        );
      });

      it("should throw on segment without =", () => {
        expect(() => backend.parseRef("user=TEST_USER,PASS")).toThrow(
          "Each segment must be key=value",
        );
      });
    });

    describe("legacy colon format", () => {
      it("should parse USER:PASS", () => {
        const result = backend.parseRef("TEST_USER:TEST_PASS");
        expect(result).toEqual({ userVar: "TEST_USER", passVar: "TEST_PASS" });
      });

      it("should throw on empty left side", () => {
        expect(() => backend.parseRef(":TEST_PASS")).toThrow(
          "Colon format requires both parts",
        );
      });

      it("should throw on empty right side", () => {
        expect(() => backend.parseRef("TEST_USER:")).toThrow(
          "Colon format requires both parts",
        );
      });
    });

    describe("error cases", () => {
      it("should throw on empty string", () => {
        expect(() => backend.parseRef("")).toThrow("Invalid env ref: empty string");
      });

      it("should throw on whitespace-only string", () => {
        expect(() => backend.parseRef("   ")).toThrow("Invalid env ref: empty string");
      });
    });
  });

  describe("getCredential", () => {
    it("should return username and password from legacy colon format", async () => {
      const result = await backend.getCredential("TEST_USER:TEST_PASS");
      expect(result.username).toBe("admin");
      expect(Buffer.isBuffer(result.password)).toBe(true);
      expect(result.password.toString("utf-8")).toBe("s3cret!");
    });

    it("should return username and password from named-key format", async () => {
      const result = await backend.getCredential("user=TEST_USER,pass=TEST_PASS");
      expect(result.username).toBe("admin");
      expect(result.password.toString("utf-8")).toBe("s3cret!");
    });

    it("should return empty username from single-var format", async () => {
      const result = await backend.getCredential("TEST_PASS");
      expect(result.username).toBe("");
      expect(result.password.toString("utf-8")).toBe("s3cret!");
    });

    it("should return empty username from named-key format without user", async () => {
      const result = await backend.getCredential("pass=TEST_PASS");
      expect(result.username).toBe("");
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

    it("should throw if password env var is not set (single-var)", async () => {
      delete process.env["TEST_PASS"];
      await expect(
        backend.getCredential("TEST_PASS"),
      ).rejects.toThrow("Environment variable not set: TEST_PASS");
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

    it("should return metadata from named-key format", async () => {
      const meta = await backend.getMetadata("user=TEST_USER,pass=TEST_PASS");
      expect(meta.username).toBe("admin");
      expect(meta.has_password).toBe(true);
    });

    it("should return empty username from single-var format", async () => {
      const meta = await backend.getMetadata("TEST_PASS");
      expect(meta.username).toBe("");
      expect(meta.has_password).toBe(true);
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
