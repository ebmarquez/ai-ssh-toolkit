import { execFile } from "child_process";
import {
  CredentialBackend,
  CredentialResult,
  CredentialMetadata,
  HealthCheckResult,
} from "./backend.js";
import { currentPlatform } from "../utils/platform.js";

/** Promisified execFile wrapper */
function execFileAsync(
  cmd: string,
  args: string[],
  opts: { timeout?: number; shell?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: stdout as string, stderr: stderr as string });
    });
  });
}

/**
 * Windows Credential Manager backend.
 *
 * ref format: "target-name"
 * Uses PowerShell's CredentialManager or cmdkey on Windows.
 *
 * Security:
 * - Windows only (platform === 'win32')
 * - Passwords returned as Buffer, zero-filled by caller
 */
export class WindowsCredentialBackend implements CredentialBackend {
  readonly name = "windows-credential";
  private stagedBuffers: Buffer[] = [];

  async isAvailable(): Promise<boolean> {
    if (currentPlatform() !== "win32") {
      return false;
    }
    try {
      await execFileAsync("cmdkey", ["/list"], { timeout: 10000 });
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
    this.validateRef(ref);

    // Use PowerShell to read credential from Windows Credential Manager
    const psScript = [
      `$cred = Get-StoredCredential -Target '${ref.replace(/'/g, "''")}';`,
      `if ($cred -eq $null) { throw 'Credential not found'; }`,
      `$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($cred.Password);`,
      `$plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr);`,
      `[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr);`,
      `Write-Output "$($cred.UserName)|$plain"`,
    ].join(" ");

    const { stdout } = await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", psScript],
      { timeout: 15000 },
    );

    const output = stdout.trim();
    const separatorIdx = output.indexOf("|");
    const username = separatorIdx !== -1 ? output.substring(0, separatorIdx) : "";
    const passwordStr = separatorIdx !== -1 ? output.substring(separatorIdx + 1) : output;

    const password = Buffer.from(passwordStr, "utf-8");
    this.stagedBuffers.push(password);

    return { username, password };
  }

  async getMetadata(ref: string): Promise<CredentialMetadata> {
    this.validateRef(ref);

    const username = "";
    let hasPassword = false;

    try {
      const { stdout } = await execFileAsync("cmdkey", ["/list"], {
        timeout: 10000,
      });
      // cmdkey /list output contains target names
      if (stdout.includes(ref)) {
        hasPassword = true;
      }
    } catch {
      // cmdkey not available or failed
    }

    return {
      username,
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

  private validateRef(ref: string): void {
    if (!ref || ref.trim().length === 0) {
      throw new Error(
        `Invalid Windows Credential ref: "${ref}". Expected a non-empty target name.`,
      );
    }
  }
}
