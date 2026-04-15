import {
  CredentialBackend,
  CredentialResult,
  CredentialMetadata,
} from "./backend.js";

/**
 * Environment variable credential backend.
 *
 * ref format: "ENV_USER:ENV_PASS" — two env var names separated by colon.
 * Example: "SWITCH_USER:SWITCH_PASS"
 *
 * Always available — no external CLI required.
 */
export class EnvCredentialBackend implements CredentialBackend {
  readonly name = "env";

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getCredential(ref: string): Promise<CredentialResult> {
    const { userVar, passVar } = this.parseRef(ref);

    const username = process.env[userVar];
    if (!username) {
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

    const username = process.env[userVar];
    const hasPassword = !!process.env[passVar];

    return {
      username: username ?? "",
      has_password: hasPassword,
      backend: this.name,
    };
  }

  async cleanup(): Promise<void> {
    // No staged secrets to wipe — reads env vars on demand
  }

  private parseRef(ref: string): { userVar: string; passVar: string } {
    const parts = ref.split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `Invalid env ref format: "${ref}". Expected "USER_VAR:PASS_VAR"`,
      );
    }
    return { userVar: parts[0], passVar: parts[1] };
  }
}
