import {
  CredentialBackend,
  CredentialResult,
  CredentialMetadata,
  HealthCheckResult,
} from "./backend.js";

/**
 * Environment variable credential backend.
 *
 * Supported ref formats (in order of preference):
 *
 * 1. "PASS_VAR"                      — password-only; username from tool arg
 * 2. "user=USER_VAR,pass=PASS_VAR"   — explicit named keys (recommended)
 * 3. "USER_VAR:PASS_VAR"             — legacy colon format (backwards compat)
 *
 * Always available — no external CLI required.
 */
export class EnvCredentialBackend implements CredentialBackend {
  readonly name = "env";

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async checkHealth(): Promise<HealthCheckResult> {
    return { available: true };
  }

  async getCredential(ref: string): Promise<CredentialResult> {
    const { userVar, passVar } = this.parseRef(ref);

    const username = userVar ? (process.env[userVar] ?? "") : "";
    if (userVar && !username) {
      throw new Error(`Environment variable not set: ${userVar}`);
    }

    const passValue = process.env[passVar];
    if (!passValue) {
      throw new Error(`Environment variable not set: ${passVar}`);
    }

    return {
      username,
      password: Buffer.from(passValue, "utf-8"),
    };
  }

  async getMetadata(ref: string): Promise<CredentialMetadata> {
    const { userVar, passVar } = this.parseRef(ref);

    const username = userVar ? (process.env[userVar] ?? "") : "";
    const hasPassword = !!process.env[passVar];

    return {
      username,
      has_password: hasPassword,
      backend: this.name,
    };
  }

  async cleanup(): Promise<void> {
    // No staged secrets to wipe — reads env vars on demand
  }

  /**
   * Parse a credential ref into optional userVar and required passVar.
   *
   * Formats:
   *   "PASS_VAR"                     → { userVar: undefined, passVar: "PASS_VAR" }
   *   "user=U,pass=P"               → { userVar: "U",       passVar: "P" }
   *   "USER_VAR:PASS_VAR"           → { userVar: "USER_VAR", passVar: "PASS_VAR" }
   */
  parseRef(ref: string): { userVar: string | undefined; passVar: string } {
    const trimmed = ref.trim();
    if (!trimmed) {
      throw new Error(
        `Invalid env ref: empty string. ` +
          `Expected "PASS_VAR" or "user=USER_VAR,pass=PASS_VAR"`,
      );
    }

    // Named-key format: "user=X,pass=Y" or "pass=Y,user=X" or "pass=Y"
    if (trimmed.includes("=")) {
      const keys = new Map<string, string>();
      for (const segment of trimmed.split(",")) {
        const eqIdx = segment.indexOf("=");
        if (eqIdx === -1) {
          throw new Error(
            `Invalid env ref: "${ref}". Each segment must be key=value. ` +
              `Expected "user=USER_VAR,pass=PASS_VAR"`,
          );
        }
        const key = segment.slice(0, eqIdx).trim().toLowerCase();
        const value = segment.slice(eqIdx + 1).trim();
        if (!key || !value) {
          throw new Error(
            `Invalid env ref: "${ref}". Empty key or value in "${segment}". ` +
              `Expected "user=USER_VAR,pass=PASS_VAR"`,
          );
        }
        if (key !== "user" && key !== "pass") {
          throw new Error(
            `Invalid env ref: "${ref}". Unknown key "${key}". ` +
              `Allowed keys: user, pass`,
          );
        }
        keys.set(key, value);
      }
      const passVar = keys.get("pass");
      if (!passVar) {
        throw new Error(
          `Invalid env ref: "${ref}". Missing required "pass" key. ` +
            `Expected "user=USER_VAR,pass=PASS_VAR"`,
        );
      }
      return { userVar: keys.get("user"), passVar };
    }

    // Legacy colon format: "USER_VAR:PASS_VAR"
    if (trimmed.includes(":")) {
      const colonIdx = trimmed.indexOf(":");
      const userVar = trimmed.slice(0, colonIdx);
      const passVar = trimmed.slice(colonIdx + 1);
      if (!userVar || !passVar) {
        throw new Error(
          `Invalid env ref: "${ref}". Colon format requires both parts. ` +
            `Expected "USER_VAR:PASS_VAR" or use "user=USER_VAR,pass=PASS_VAR"`,
        );
      }
      return { userVar, passVar };
    }

    // Single variable: password-only, username comes from tool arg
    return { userVar: undefined, passVar: trimmed };
  }
}
