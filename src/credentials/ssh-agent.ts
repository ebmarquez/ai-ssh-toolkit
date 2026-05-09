import { execFile } from "child_process";
import { promisify } from "util";
import {
  CredentialBackend,
  CredentialResult,
  CredentialMetadata,
  HealthCheckResult,
} from "./backend.js";

const execFileAsync = promisify(execFile);

/**
 * SSH Agent credential backend.
 *
 * Delegates authentication to a running ssh-agent via SSH_AUTH_SOCK.
 * Never handles key material — the agent performs signing internally.
 *
 * ref format: "username" or "username:fingerprint"
 *   - username: SSH login user
 *   - fingerprint: optional key fingerprint/comment to select a specific identity
 *
 * On Windows, falls back to the OpenSSH named pipe when SSH_AUTH_SOCK is unset.
 */
export class SshAgentBackend implements CredentialBackend {
  readonly name = "ssh-agent";

  private static readonly WINDOWS_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";

  async isAvailable(): Promise<boolean> {
    const health = await this.checkHealth();
    return health.available;
  }

  async checkHealth(): Promise<HealthCheckResult> {
    const sock = this.getAgentSocket();
    if (!sock) {
      return { available: false, reason: 'SSH_AUTH_SOCK is not set and no agent socket found' };
    }

    try {
      const { stdout } = await execFileAsync("ssh-add", ["-l"], {
        timeout: 5000,
        env: { ...process.env, SSH_AUTH_SOCK: sock },
      });
      if (stdout.trim().length > 0) {
        return { available: true };
      }
      return { available: false, reason: 'ssh-agent is running but has no identities loaded — run \'ssh-add\' to add keys' };
    } catch (err: unknown) {
      const exitCode = (err as { code?: number }).code;
      if (exitCode === 1) {
        return { available: false, reason: 'ssh-agent is running but has no identities loaded — run \'ssh-add\' to add keys' };
      }
      return { available: false, reason: 'ssh-agent is not reachable — is the agent daemon running?' };
    }
  }

  async getCredential(ref: string): Promise<CredentialResult> {
    const { username } = this.parseRef(ref);

    // Never return key material — agent handles signing internally.
    // Return empty Buffer for password; SSH will authenticate via agent.
    return {
      username,
      password: Buffer.alloc(0),
    };
  }

  async getMetadata(ref: string): Promise<CredentialMetadata> {
    const { username } = this.parseRef(ref);

    return {
      username,
      has_password: false,
      backend: this.name,
    };
  }

  async cleanup(): Promise<void> {
    // No secrets to wipe — agent backend never handles key material
  }

  /**
   * List identities from the agent (fingerprints and comments only).
   * Never exposes private key material.
   */
  async listIdentities(): Promise<string[]> {
    const sock = this.getAgentSocket();
    if (!sock) return [];

    try {
      const { stdout } = await execFileAsync("ssh-add", ["-l"], {
        timeout: 5000,
        env: { ...process.env, SSH_AUTH_SOCK: sock },
      });
      // Each line: "2048 SHA256:abc123... comment (RSA)"
      return stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }

  private getAgentSocket(): string | undefined {
    // Prefer SSH_AUTH_SOCK env var
    if (process.env.SSH_AUTH_SOCK) {
      return process.env.SSH_AUTH_SOCK;
    }

    // Windows fallback: OpenSSH named pipe
    if (process.platform === "win32") {
      return SshAgentBackend.WINDOWS_PIPE;
    }

    return undefined;
  }

  private parseRef(ref: string): { username: string; fingerprint?: string } {
    if (!ref || ref.trim().length === 0) {
      throw new Error(
        'Invalid ssh-agent ref: ref must contain at least a username. Format: "username" or "username:fingerprint"',
      );
    }

    const colonIdx = ref.indexOf(":");
    if (colonIdx === -1) {
      return { username: ref.trim() };
    }

    const username = ref.substring(0, colonIdx).trim();
    const fingerprint = ref.substring(colonIdx + 1).trim();

    if (!username) {
      throw new Error(
        `Invalid ssh-agent ref: "${ref}". Username cannot be empty. Format: "username" or "username:fingerprint"`,
      );
    }

    return { username, fingerprint: fingerprint || undefined };
  }
}
