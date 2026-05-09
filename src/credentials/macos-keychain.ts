import { execFile } from "child_process";
import {
  CredentialBackend,
  CredentialResult,
  CredentialMetadata,
  HealthCheckResult,
} from "./backend.js";
import { currentPlatform } from "../utils/platform.js";
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
 * macOS Keychain credential backend.
 *
 * ref format: "service-name:account-name"
 * Uses the macOS `security` CLI to retrieve credentials from the login keychain.
 *
 * Security:
 * - macOS only (platform === 'darwin')
 * - Passwords returned as Buffer, zero-filled by caller
 */
export class MacOsKeychainBackend implements CredentialBackend {
  readonly name = "macos-keychain";
  private cliPath: string | null = null;
  private stagedBuffers: Buffer[] = [];

  async isAvailable(): Promise<boolean> {
    try {
      if (currentPlatform() !== "darwin") {
        return false;
      }
      this.cliPath = resolveCliPath("security");
      return true;
    } catch {
      return false;
    }
  }

  async checkHealth(): Promise<HealthCheckResult> {
    const available = await this.isAvailable();
    return available
      ? { available: true }
      : { available: false, reason: `${this.name} backend is not available` };
  }

  async getCredential(ref: string): Promise<CredentialResult> {
    const cli = await this.resolveCli();
    const { serviceName, accountName } = this.parseRef(ref);

    // `security find-generic-password -w` outputs password to stdout
    const { stdout } = await execFileAsync(
      cli,
      ["find-generic-password", "-s", serviceName, "-a", accountName, "-w"],
      { timeout: 10000 },
    );

    const password = Buffer.from(stdout.trim(), "utf-8");
    this.stagedBuffers.push(password);

    return { username: accountName, password };
  }

  async getMetadata(ref: string): Promise<CredentialMetadata> {
    const cli = await this.resolveCli();
    const { serviceName, accountName } = this.parseRef(ref);

    let hasPassword = false;
    try {
      await execFileAsync(
        cli,
        ["find-generic-password", "-s", serviceName, "-a", accountName],
        { timeout: 10000 },
      );
      hasPassword = true;
    } catch {
      // Keychain item not found
    }

    return {
      username: accountName,
      has_password: hasPassword,
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
   * Parse ref format: "service-name:account-name"
   */
  private parseRef(ref: string): {
    serviceName: string;
    accountName: string;
  } {
    const colonIdx = ref.indexOf(":");
    if (colonIdx === -1 || colonIdx === 0 || colonIdx === ref.length - 1) {
      throw new Error(
        `Invalid macOS Keychain ref format: "${ref}". Expected "service-name:account-name"`,
      );
    }

    return {
      serviceName: ref.substring(0, colonIdx),
      accountName: ref.substring(colonIdx + 1),
    };
  }

  private async resolveCli(): Promise<string> {
    if (!this.cliPath) {
      this.cliPath = resolveCliPath("security");
    }
    return this.cliPath;
  }
}
