import { execFile } from "child_process";
import {
  CredentialBackend,
  CredentialResult,
  CredentialMetadata,
} from "./backend.js";
import { resolveCliPath } from "../utils/cli-resolver.js";

/** Promisified execFile wrapper */
function execFileAsync(
  cmd: string,
  args: string[],
  opts: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: stdout as string, stderr: stderr as string });
    });
  });
}

/**
 * 1Password CLI credential backend.
 *
 * ref format: "op://vault/item/username-field:password-field"
 * Requires `op` CLI installed and signed in.
 *
 * Security:
 * - Passwords returned as Buffer, zero-filled by caller
 * - CLI resolved to absolute path
 */
export class OnePasswordBackend implements CredentialBackend {
  readonly name = "onepassword";
  private cliPath: string | null = null;
  private stagedBuffers: Buffer[] = [];

  async isAvailable(): Promise<boolean> {
    try {
      this.cliPath = resolveCliPath("op");
      await execFileAsync(this.cliPath, ["whoami"], { timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }

  async getCredential(ref: string): Promise<CredentialResult> {
    const cli = await this.resolveCli();
    const { usernameRef, passwordRef } = this.parseRef(ref);

    const [username, passwordRaw] = await Promise.all([
      this.readField(cli, usernameRef),
      this.readField(cli, passwordRef),
    ]);

    const password = Buffer.from(passwordRaw, "utf-8");
    this.stagedBuffers.push(password);

    return { username, password };
  }

  async getMetadata(ref: string): Promise<CredentialMetadata> {
    const cli = await this.resolveCli();
    const { usernameRef } = this.parseRef(ref);

    const username = await this.readField(cli, usernameRef).catch(() => "");

    return {
      username,
      has_password: true,
      backend: this.name,
    };
  }

  async cleanup(): Promise<void> {
    for (const buf of this.stagedBuffers) {
      buf.fill(0);
    }
    this.stagedBuffers = [];
  }

  /**
   * Parse ref format: "op://vault/item/username-field:password-field"
   * The colon separates the username field name from the password field name.
   */
  private parseRef(ref: string): { usernameRef: string; passwordRef: string } {
    const colonIdx = ref.lastIndexOf(":");
    if (colonIdx === -1) {
      throw new Error(
        `Invalid 1Password ref format: "${ref}". Expected "op://vault/item/username-field:password-field"`,
      );
    }

    const usernameRef = ref.substring(0, colonIdx);
    const passwordFieldName = ref.substring(colonIdx + 1);

    if (!usernameRef || !passwordFieldName) {
      throw new Error(
        `Invalid 1Password ref format: "${ref}". Both username and password field refs are required.`,
      );
    }

    // Build the password ref by replacing the last path segment
    const lastSlash = usernameRef.lastIndexOf("/");
    if (lastSlash === -1) {
      throw new Error(
        `Invalid 1Password ref format: "${ref}". Expected "op://vault/item/field" prefix.`,
      );
    }
    const passwordRef = usernameRef.substring(0, lastSlash + 1) + passwordFieldName;

    return { usernameRef, passwordRef };
  }

  private async readField(cli: string, fieldRef: string): Promise<string> {
    const { stdout } = await execFileAsync(cli, ["read", fieldRef], {
      timeout: 15000,
    });
    return stdout.trim();
  }

  private async resolveCli(): Promise<string> {
    if (!this.cliPath) {
      this.cliPath = resolveCliPath("op");
    }
    return this.cliPath;
  }
}
