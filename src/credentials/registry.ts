import type { CredentialBackend, CredentialMetadata, CredentialResult } from './backend.js';

export interface BackendStatus {
  name: string;
  available: boolean;
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

  /** Register a backend instance */
  register(backend: CredentialBackend): void {
    if (this.backends.has(backend.name)) {
      throw new Error(`Backend already registered: ${backend.name}`);
    }
    this.backends.set(backend.name, backend);
  }

  /** Probe all registered backends for availability */
  async discoverAvailability(): Promise<BackendStatus[]> {
    const results: BackendStatus[] = [];

    for (const [name, backend] of this.backends) {
      try {
        const available = await backend.isAvailable();
        this.availability.set(name, available);
        results.push({ name, available });
      } catch {
        this.availability.set(name, false);
        results.push({ name, available: false });
      }
    }

    return results;
  }

  /** List all backends with cached availability status */
  listBackends(): BackendStatus[] {
    return Array.from(this.backends.keys()).map((name) => ({
      name,
      available: this.availability.get(name) ?? false,
    }));
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

  /** Number of registered backends */
  get size(): number {
    return this.backends.size;
  }
}
