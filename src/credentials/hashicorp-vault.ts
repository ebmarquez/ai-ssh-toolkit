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
  opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: stdout as string, stderr: stderr as string });
    });
  });
}

/**
 * HashiCorp Vault credential backend.
 *
 * ref format: "secret/path#username_field:password_field"
 * Requires VAULT_ADDR env var and either VAULT_TOKEN or `vault` CLI authenticated.
 *
 * Security:
 * - Passwords returned as Buffer, zero-filled by caller
 * - Uses vault CLI with KV get
 */
export class HashiCorpVaultBackend implements CredentialBackend {
  readonly name = "hashicorp-vault";
  private cliPath: string | null = null;
  private stagedBuffers: Buffer[] = [];

  async isAvailable(): Promise<boolean> {
    try {
      if (!process.env.VAULT_ADDR) {
        return false;
      }
      this.cliPath = resolveCliPath("vault");
      await execFileAsync(this.cliPath, ["token", "lookup"], {
        timeout: 10000,
        env: this.buildEnv(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async getCredential(ref: string): Promise<CredentialResult> {
    const cli = await this.resolveCli();
    const { path, usernameField, passwordField } = this.parseRef(ref);

    const { stdout } = await execFileAsync(
      cli,
      ["kv", "get", "-format=json", path],
      { timeout: 15000, env: this.buildEnv() },
    );

    const result = JSON.parse(stdout);
    const data = result.data?.data ?? result.data ?? {};

    const username = String(data[usernameField] ?? "");
    const passwordValue = String(data[passwordField] ?? "");
    const password = Buffer.from(passwordValue, "utf-8");
    this.stagedBuffers.push(password);

    return { username, password };
  }

  async getMetadata(ref: string): Promise<CredentialMetadata> {
    const cli = await this.resolveCli();
    const { path, usernameField, passwordField } = this.parseRef(ref);

    const { stdout } = await execFileAsync(
      cli,
      ["kv", "get", "-format=json", path],
      { timeout: 15000, env: this.buildEnv() },
    );

    const result = JSON.parse(stdout);
    const data = result.data?.data ?? result.data ?? {};

    return {
      username: String(data[usernameField] ?? ""),
      has_password: !!data[passwordField],
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
   * Parse ref format: "secret/path#username_field:password_field"
   */
  private parseRef(ref: string): {
    path: string;
    usernameField: string;
    passwordField: string;
  } {
    const hashIdx = ref.indexOf("#");
    if (hashIdx === -1) {
      throw new Error(
        `Invalid Vault ref format: "${ref}". Expected "secret/path#username_field:password_field"`,
      );
    }

    const path = ref.substring(0, hashIdx);
    const fieldPart = ref.substring(hashIdx + 1);
    const colonIdx = fieldPart.indexOf(":");
    if (colonIdx === -1) {
      throw new Error(
        `Invalid Vault ref format: "${ref}". Expected "secret/path#username_field:password_field"`,
      );
    }

    const usernameField = fieldPart.substring(0, colonIdx);
    const passwordField = fieldPart.substring(colonIdx + 1);

    if (!path || !usernameField || !passwordField) {
      throw new Error(
        `Invalid Vault ref format: "${ref}". All parts (path, username_field, password_field) are required.`,
      );
    }

    return { path, usernameField, passwordField };
  }

  private buildEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
  }

  private async resolveCli(): Promise<string> {
    if (!this.cliPath) {
      this.cliPath = resolveCliPath("vault");
    }
    return this.cliPath;
  }
}
