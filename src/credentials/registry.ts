import type { CredentialBackend, CredentialMetadata, CredentialResult, HealthCheckResult } from './backend.js';

export type { HealthCheckResult } from './backend.js';

export interface BackendStatus {
  name: string;
  available: boolean;
  reason?: string;
}

/**
 * Registry for credential backends.
 *
 * Manages backend lifecycle: registration, availability discovery,
 * credential retrieval delegation, and cleanup.
 */
export class CredentialRegistry {
  private backends: Map<string, CredentialBackend> = new Map();
  private availability: Map<string, boolean> = new Map();
  private diagnostics: Map<string, string | undefined> = new Map();

  /** Register a backend instance */
  register(backend: CredentialBackend): void {
    if (this.backends.has(backend.name)) {
      throw new Error(`Backend already registered: ${backend.name}`);
    }
    this.backends.set(backend.name, backend);
  }

  /** Probe all registered backends for availability */
  async discoverAvailability(): Promise<BackendStatus[]> {
    const entries = Array.from(this.backends.entries());

    const results = await Promise.all(
      entries.map(async ([name, backend]): Promise<BackendStatus> => {
        try {
          const health = await backend.checkHealth();
          this.availability.set(name, health.available);
          this.diagnostics.set(name, health.reason);
          const status: BackendStatus = { name, available: health.available };
          if (health.reason) status.reason = health.reason;
          return status;
        } catch (err) {
          const reason = `Health check threw: ${err instanceof Error ? err.message : String(err)}`;
          this.availability.set(name, false);
          this.diagnostics.set(name, reason);
          return { name, available: false, reason };
        }
      })
    );

    return results;
  }

  /** List all backends with cached availability status */
  listBackends(): BackendStatus[] {
    return Array.from(this.backends.keys()).map((name) => {
      const status: BackendStatus = {
        name,
        available: this.availability.get(name) ?? false,
      };
      const reason = this.diagnostics.get(name);
      if (reason) status.reason = reason;
      return status;
    });
  }

  /** Get a credential from a specific backend */
  async getCredential(backendName: string, ref: string): Promise<CredentialResult> {
    const backend = this.getBackend(backendName);
    return backend.getCredential(ref);
  }

  /** Get metadata from a specific backend */
  async getMetadata(backendName: string, ref: string): Promise<CredentialMetadata> {
    const backend = this.getBackend(backendName);
    return backend.getMetadata(ref);
  }

  /** Cleanup all backends — wipe staged secrets */
  async cleanupAll(): Promise<void> {
    for (const backend of this.backends.values()) {
      await backend.cleanup();
    }
  }

  /** Get a registered backend by name */
  getBackend(name: string): CredentialBackend {
    const backend = this.backends.get(name);
    if (!backend) {
      throw new Error(`Unknown credential backend: ${name}`);
    }
    return backend;
  }

  /** Check if a specific backend is available */
  isAvailable(name: string): boolean {
    return this.availability.get(name) ?? false;
  }

  /** Get cached diagnostic reason for a backend (if any) */
  getDiagnostic(name: string): string | undefined {
    return this.diagnostics.get(name);
  }

  /** Number of registered backends */
  get size(): number {
    return this.backends.size;
  }
}
