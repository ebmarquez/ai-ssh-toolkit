import { execFile } from "child_process";
import { promisify } from "util";
import {
  CredentialBackend,
  CredentialResult,
  CredentialMetadata,
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
    // Check SSH_AUTH_SOCK is set (or Windows named pipe exists)
    const sock = this.getAgentSocket();
    if (!sock) return false;

    // Probe the agent with ssh-add -l to verify it is reachable and has keys
    try {
      const { stdout } = await execFileAsync("ssh-add", ["-l"], {
        timeout: 5000,
        env: { ...process.env, SSH_AUTH_SOCK: sock },
      });
      // ssh-add -l exits 0 when identities are present
      // Output contains lines like: "2048 SHA256:... comment (RSA)"
      return stdout.trim().length > 0;
    } catch {
      // Exit code 1 = agent reachable but no identities
      // Exit code 2 = agent not reachable
      return false;
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
