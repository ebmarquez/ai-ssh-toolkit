/**
 * Credential backend plugin interface.
 *
 * ALL implementations MUST:
 * - Return passwords as Buffer (never string)
 * - Support cleanup() to wipe staged secrets
 * - Use stdin piping for CLI calls (never argv)
 */
export interface CredentialResult {
  username: string;
  password: Buffer;
}

export interface CredentialMetadata {
  username: string;
  has_password: boolean;
  backend: string;
}

export interface HealthCheckResult {
  available: boolean;
  /** Human-readable reason when unavailable — never contains credential material */
  reason?: string;
}

export interface CredentialBackend {
  readonly name: string;

  /** Check if this backend's prerequisites are met */
  isAvailable(): Promise<boolean>;

  /**
   * Structured health check with diagnostic reason on failure.
   * Reason text must never contain credential material — only
   * infrastructure status (CLI missing, env var unset, auth expired, etc.).
   */
  checkHealth(): Promise<HealthCheckResult>;

  /** Retrieve credential — password as Buffer, zero-fill after use */
  getCredential(ref: string): Promise<CredentialResult>;

  /** Return metadata only — NEVER expose password */
  getMetadata(ref: string): Promise<CredentialMetadata>;

  /** Wipe any staged secrets from memory */
  cleanup(): Promise<void>;
}
