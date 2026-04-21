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
 * Bitwarden CLI credential backend.
 *
 * ref format: Bitwarden item name (e.g. "switch-admin-creds").
 * Requires `bw` CLI installed and vault unlocked.
 *
 * Security:
 * - Session key passed via --session flag, never BW_SESSION env var
 * - Passwords returned as Buffer, zero-filled by caller
 * - CLI resolved to absolute path at construction time
 */
export class BitwardenBackend implements CredentialBackend {
  readonly name = "bitwarden";
  private cliPath: string | null = null;
  private sessionKey: string | null = null;
  private stagedBuffers: Buffer[] = [];

  async isAvailable(): Promise<boolean> {
    try {
      this.cliPath = resolveCliPath("bw");
      this.hydrateSessionKeyFromEnv();
      const args = this.sessionKey ? ["status", "--session", this.sessionKey] : ["status"];
      const { stdout } = await execFileAsync(this.cliPath, args, {
        timeout: 10000,
      });
      const status = JSON.parse(stdout);
      if (status.status === "unlocked") {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async getCredential(ref: string): Promise<CredentialResult> {
    const cli = await this.resolveCli();
    const args = this.buildArgs(["get", "item", ref]);

    const { stdout } = await execFileAsync(cli, args, { timeout: 15000 });
    const item = JSON.parse(stdout);

    if (!item.login) {
      throw new Error(`Bitwarden item "${ref}" has no login credentials`);
    }

    const password = Buffer.from(item.login.password ?? "", "utf-8");
    this.stagedBuffers.push(password);

    return {
      username: item.login.username ?? "",
      password,
    };
  }

  async getMetadata(ref: string): Promise<CredentialMetadata> {
    const cli = await this.resolveCli();
    const args = this.buildArgs(["get", "item", ref]);

    const { stdout } = await execFileAsync(cli, args, { timeout: 15000 });
    const item = JSON.parse(stdout);

    return {
      username: item.login?.username ?? "",
      has_password: !!item.login?.password,
      backend: this.name,
    };
  }

  async cleanup(): Promise<void> {
    for (const buf of this.stagedBuffers) {
      buf.fill(0);
    }
    this.stagedBuffers = [];
  }

  /** Set session key for unlocked vault access */
  setSessionKey(key: string): void {
    this.sessionKey = key;
  }

  private async resolveCli(): Promise<string> {
    if (!this.cliPath) {
      this.cliPath = resolveCliPath("bw");
    }
    this.hydrateSessionKeyFromEnv();
    return this.cliPath;
  }

  private hydrateSessionKeyFromEnv(): void {
    if (!this.sessionKey && process.env.BW_SESSION) {
      this.sessionKey = process.env.BW_SESSION;
    }
  }

  private buildArgs(baseArgs: string[]): string[] {
    const args = [...baseArgs, "--raw"];
    if (this.sessionKey) {
      args.push("--session", this.sessionKey);
    }
    return args;
  }
}
