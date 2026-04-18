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
 * Azure Key Vault credential backend.
 *
 * ref format: "vault-name/secret-name" — vault and secret separated by slash.
 * Optionally "vault-name/user-secret:pass-secret" for separate user+pass secrets.
 *
 * Requires `az` CLI installed and authenticated (`az login`).
 *
 * Security:
 * - CLI resolved to absolute path at construction time
 * - Passwords returned as Buffer, zero-filled by caller
 * - No temp files — secrets read via stdout only
 */
export class AzureKeyVaultBackend implements CredentialBackend {
  readonly name = "azure-keyvault";
  private cliPath: string | null = null;
  private stagedBuffers: Buffer[] = [];

  async isAvailable(): Promise<boolean> {
    try {
      this.cliPath = resolveCliPath("az");
      await execFileAsync(this.cliPath, ["account", "show"], {
        timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async getCredential(ref: string): Promise<CredentialResult> {
    const { vaultName, secretName } = this.parseRef(ref);
    const cli = await this.resolveCli();

    // Check if secretName contains ":" for separate user/pass secrets
    if (secretName.includes(":")) {
      const [userSecret, passSecret] = secretName.split(":");
      const [username, password] = await Promise.all([
        this.fetchSecret(cli, vaultName, userSecret),
        this.fetchSecret(cli, vaultName, passSecret),
      ]);

      const pwBuf = Buffer.from(password, "utf-8");
      this.stagedBuffers.push(pwBuf);

      return { username, password: pwBuf };
    }

    // Single secret — assume JSON with username/password fields
    const secretValue = await this.fetchSecret(cli, vaultName, secretName);

    // Try JSON parse first
    try {
      const parsed = JSON.parse(secretValue);
      const pwBuf = Buffer.from(parsed.password ?? "", "utf-8");
      this.stagedBuffers.push(pwBuf);
      return {
        username: parsed.username ?? "",
        password: pwBuf,
      };
    } catch {
      // Plain string — treat as password, username must come from elsewhere
      const pwBuf = Buffer.from(secretValue, "utf-8");
      this.stagedBuffers.push(pwBuf);
      return { username: "", password: pwBuf };
    }
  }

  async getMetadata(ref: string): Promise<CredentialMetadata> {
    const { vaultName, secretName } = this.parseRef(ref);
    const cli = await this.resolveCli();

    try {
      // Just check the secret exists — don't fetch the value for metadata
      await execFileAsync(
        cli,
        [
          "keyvault",
          "secret",
          "show",
          "--vault-name",
          vaultName,
          "--name",
          secretName.split(":")[0],
          "--query",
          "name",
          "-o",
          "tsv",
        ],
        { timeout: 15000 },
      );

      return {
        username: "",
        has_password: true,
        backend: this.name,
      };
    } catch {
      return {
        username: "",
        has_password: false,
        backend: this.name,
      };
    }
  }

  async cleanup(): Promise<void> {
    for (const buf of this.stagedBuffers) {
      buf.fill(0);
    }
    this.stagedBuffers = [];
  }

  private parseRef(ref: string): { vaultName: string; secretName: string } {
    const slashIdx = ref.indexOf("/");
    if (slashIdx === -1 || slashIdx === 0 || slashIdx === ref.length - 1) {
      throw new Error(
        `Invalid Azure KV ref format: "${ref}". Expected "vault-name/secret-name"`,
      );
    }
    return {
      vaultName: ref.substring(0, slashIdx),
      secretName: ref.substring(slashIdx + 1),
    };
  }

  private async fetchSecret(
    cli: string,
    vaultName: string,
    secretName: string,
  ): Promise<string> {
    const { stdout } = await execFileAsync(
      cli,
      [
        "keyvault",
        "secret",
        "show",
        "--vault-name",
        vaultName,
        "--name",
        secretName,
        "--query",
        "value",
        "-o",
        "tsv",
      ],
      { timeout: 15000 },
    );
    return stdout.trim();
  }

  private async resolveCli(): Promise<string> {
    if (!this.cliPath) {
      this.cliPath = resolveCliPath("az");
    }
    return this.cliPath;
  }
}
