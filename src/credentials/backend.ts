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

export interface CredentialBackend {
  readonly name: string;

  /** Check if this backend's prerequisites are met */
  isAvailable(): Promise<boolean>;

  /** Retrieve credential — password as Buffer, zero-fill after use */
  getCredential(ref: string): Promise<CredentialResult>;

  /** Return metadata only — NEVER expose password */
  getMetadata(ref: string): Promise<CredentialMetadata>;

  /** Wipe any staged secrets from memory */
  cleanup(): Promise<void>;
}
