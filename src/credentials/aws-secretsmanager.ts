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
 * AWS Secrets Manager credential backend.
 *
 * ref format:
 *   "secret-name#username_key:password_key"
 *   "arn:aws:secretsmanager:...:secret:name#username_key:password_key"
 *
 * Uses `aws` CLI to retrieve secrets. Requires AWS CLI installed and configured.
 *
 * Security:
 * - Passwords returned as Buffer, zero-filled by caller
 * - CLI resolved to absolute path
 */
export class AwsSecretsManagerBackend implements CredentialBackend {
  readonly name = "aws-secretsmanager";
  private cliPath: string | null = null;
  private stagedBuffers: Buffer[] = [];

  async isAvailable(): Promise<boolean> {
    try {
      this.cliPath = resolveCliPath("aws");
      await execFileAsync(this.cliPath, ["sts", "get-caller-identity"], {
        timeout: 10000,
        env: { ...process.env },
      });
      return true;
    } catch {
      return false;
    }
  }

  async getCredential(ref: string): Promise<CredentialResult> {
    const cli = await this.resolveCli();
    const { secretId, usernameKey, passwordKey } = this.parseRef(ref);

    const { stdout } = await execFileAsync(
      cli,
      [
        "secretsmanager",
        "get-secret-value",
        "--secret-id",
        secretId,
        "--output",
        "json",
      ],
      { timeout: 15000, env: { ...process.env } },
    );

    const result = JSON.parse(stdout);
    const secretData = JSON.parse(result.SecretString ?? "{}");

    const username = String(secretData[usernameKey] ?? "");
    const passwordValue = String(secretData[passwordKey] ?? "");
    const password = Buffer.from(passwordValue, "utf-8");
    this.stagedBuffers.push(password);

    return { username, password };
  }

  async getMetadata(ref: string): Promise<CredentialMetadata> {
    const cli = await this.resolveCli();
    const { secretId, usernameKey, passwordKey } = this.parseRef(ref);

    const { stdout } = await execFileAsync(
      cli,
      [
        "secretsmanager",
        "get-secret-value",
        "--secret-id",
        secretId,
        "--output",
        "json",
      ],
      { timeout: 15000, env: { ...process.env } },
    );

    const result = JSON.parse(stdout);
    const secretData = JSON.parse(result.SecretString ?? "{}");

    return {
      username: String(secretData[usernameKey] ?? ""),
      has_password: !!secretData[passwordKey],
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
   * Parse ref format: "secret-name#username_key:password_key"
   * or "arn:aws:...#username_key:password_key"
   */
  private parseRef(ref: string): {
    secretId: string;
    usernameKey: string;
    passwordKey: string;
  } {
    // For ARN refs, the # separator follows the ARN
    const hashIdx = ref.lastIndexOf("#");
    if (hashIdx === -1) {
      throw new Error(
        `Invalid AWS Secrets Manager ref format: "${ref}". Expected "secret-name#username_key:password_key"`,
      );
    }

    const secretId = ref.substring(0, hashIdx);
    const fieldPart = ref.substring(hashIdx + 1);
    const colonIdx = fieldPart.indexOf(":");
    if (colonIdx === -1) {
      throw new Error(
        `Invalid AWS Secrets Manager ref format: "${ref}". Expected "secret-name#username_key:password_key"`,
      );
    }

    const usernameKey = fieldPart.substring(0, colonIdx);
    const passwordKey = fieldPart.substring(colonIdx + 1);

    if (!secretId || !usernameKey || !passwordKey) {
      throw new Error(
        `Invalid AWS Secrets Manager ref format: "${ref}". All parts (secret-id, username_key, password_key) are required.`,
      );
    }

    return { secretId, usernameKey, passwordKey };
  }

  private async resolveCli(): Promise<string> {
    if (!this.cliPath) {
      this.cliPath = resolveCliPath("aws");
    }
    return this.cliPath;
  }
}
