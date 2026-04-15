import { describe, it, expect, beforeEach, vi } from "vitest";
import { CredentialRegistry } from "../../src/credentials/registry.js";
import type {
  CredentialBackend,
  CredentialResult,
  CredentialMetadata,
} from "../../src/credentials/backend.js";

/** Create a mock backend for testing */
function createMockBackend(
  name: string,
  available: boolean = true,
): CredentialBackend {
  return {
    name,
    isAvailable: vi.fn(async () => available),
    getCredential: vi.fn(async (): Promise<CredentialResult> => ({
      username: `${name}-user`,
      password: Buffer.from(`${name}-pass`),
    })),
    getMetadata: vi.fn(async (): Promise<CredentialMetadata> => ({
      username: `${name}-user`,
      has_password: true,
      backend: name,
    })),
    cleanup: vi.fn(async () => {}),
  };
}

describe("CredentialRegistry", () => {
  let registry: CredentialRegistry;

  beforeEach(() => {
    registry = new CredentialRegistry();
  });

  describe("register", () => {
    it("should register a backend", () => {
      const backend = createMockBackend("test");
      registry.register(backend);
      expect(registry.size).toBe(1);
    });

    it("should throw on duplicate registration", () => {
      const b1 = createMockBackend("test");
      const b2 = createMockBackend("test");
      registry.register(b1);
      expect(() => registry.register(b2)).toThrow(
        "Backend already registered: test",
      );
    });

    it("should register multiple backends", () => {
      registry.register(createMockBackend("env"));
      registry.register(createMockBackend("bitwarden"));
      registry.register(createMockBackend("azure-keyvault"));
      expect(registry.size).toBe(3);
    });
  });

  describe("discoverAvailability", () => {
    it("should probe all backends and return status", async () => {
      registry.register(createMockBackend("env", true));
      registry.register(createMockBackend("bitwarden", false));

      const results = await registry.discoverAvailability();
      expect(results).toEqual([
        { name: "env", available: true },
        { name: "bitwarden", available: false },
      ]);
    });

    it("should handle isAvailable() throwing as unavailable", async () => {
      const broken: CredentialBackend = {
        name: "broken",
        isAvailable: vi.fn(async () => {
          throw new Error("crash");
        }),
        getCredential: vi.fn(),
        getMetadata: vi.fn(),
        cleanup: vi.fn(),
      };
      registry.register(broken);

      const results = await registry.discoverAvailability();
      expect(results).toEqual([{ name: "broken", available: false }]);
    });

    it("should cache availability results", async () => {
      registry.register(createMockBackend("env", true));
      await registry.discoverAvailability();
      expect(registry.isAvailable("env")).toBe(true);
    });
  });

  describe("listBackends", () => {
    it("should list all registered backends with availability", async () => {
      registry.register(createMockBackend("env", true));
      registry.register(createMockBackend("bitwarden", false));
      await registry.discoverAvailability();

      const list = registry.listBackends();
      expect(list).toEqual([
        { name: "env", available: true },
        { name: "bitwarden", available: false },
      ]);
    });

    it("should default availability to false before discovery", () => {
      registry.register(createMockBackend("env", true));
      const list = registry.listBackends();
      expect(list).toEqual([{ name: "env", available: false }]);
    });
  });

  describe("getCredential", () => {
    it("should delegate to the correct backend", async () => {
      const backend = createMockBackend("env");
      registry.register(backend);

      const result = await registry.getCredential("env", "MY_USER:MY_PASS");
      expect(result.username).toBe("env-user");
      expect(backend.getCredential).toHaveBeenCalledWith("MY_USER:MY_PASS");
    });

    it("should throw for unknown backend", async () => {
      await expect(
        registry.getCredential("nonexistent", "ref"),
      ).rejects.toThrow("Unknown credential backend: nonexistent");
    });
  });

  describe("getMetadata", () => {
    it("should delegate to the correct backend", async () => {
      const backend = createMockBackend("bitwarden");
      registry.register(backend);

      const meta = await registry.getMetadata("bitwarden", "switch-creds");
      expect(meta.backend).toBe("bitwarden");
      expect(backend.getMetadata).toHaveBeenCalledWith("switch-creds");
    });

    it("should throw for unknown backend", async () => {
      await expect(
        registry.getMetadata("nonexistent", "ref"),
      ).rejects.toThrow("Unknown credential backend: nonexistent");
    });
  });

  describe("getBackend", () => {
    it("should return the registered backend by name", () => {
      const backend = createMockBackend("env");
      registry.register(backend);
      expect(registry.getBackend("env")).toBe(backend);
    });

    it("should throw for unknown backend", () => {
      expect(() => registry.getBackend("missing")).toThrow(
        "Unknown credential backend: missing",
      );
    });
  });

  describe("cleanupAll", () => {
    it("should call cleanup on all registered backends", async () => {
      const b1 = createMockBackend("env");
      const b2 = createMockBackend("bitwarden");
      registry.register(b1);
      registry.register(b2);

      await registry.cleanupAll();
      expect(b1.cleanup).toHaveBeenCalled();
      expect(b2.cleanup).toHaveBeenCalled();
    });
  });

  describe("isAvailable", () => {
    it("should return false for unregistered backend", () => {
      expect(registry.isAvailable("ghost")).toBe(false);
    });

    it("should return cached value after discovery", async () => {
      registry.register(createMockBackend("env", true));
      registry.register(createMockBackend("bw", false));
      await registry.discoverAvailability();

      expect(registry.isAvailable("env")).toBe(true);
      expect(registry.isAvailable("bw")).toBe(false);
    });
  });
});
