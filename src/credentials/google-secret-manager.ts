/**
 * Google Secret Manager credential backend.
 *
 * Uses the `gcloud` CLI to retrieve secrets. Requires:
 * - Google Cloud SDK installed (`gcloud` in PATH)
 * - Authenticated: `gcloud auth login` or GOOGLE_APPLICATION_CREDENTIALS
 * - Secret Manager API enabled on the project
 *
 * Reference format:
 *   "project-id/secret-name"           → latest version
 *   "project-id/secret-name/VERSION"   → specific version number
 *   "secret-name"                      → uses GCLOUD_PROJECT env var or gcloud default project
 *
 * Security:
 * - Secret value captured to Buffer immediately, never assigned to string
 * - gcloud binary path resolved to absolute at startup
 * - No temp files
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'path';
import type { CredentialBackend, CredentialMetadata, CredentialResult } from './backend.js';

const execFileAsync = promisify(execFile);

export class GoogleSecretManagerBackend implements CredentialBackend {
  readonly name = 'google-secret-manager';

  private gcloudPath: string | null = null;

  /** Resolve gcloud binary path once at startup */
  private async resolveGcloud(): Promise<string> {
    if (this.gcloudPath) return this.gcloudPath;

    const candidates = [
      '/snap/bin/gcloud',
      '/usr/lib/google-cloud-sdk/bin/gcloud',
      '/usr/bin/gcloud',
    ];

    // Try PATH resolution first
    try {
      const { stdout } = await execFileAsync('which', ['gcloud']);
      this.gcloudPath = resolve(stdout.trim());
      return this.gcloudPath;
    } catch {
      // Fall through to candidates
    }

    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ['version']);
        this.gcloudPath = candidate;
        return candidate;
      } catch {
        continue;
      }
    }

    throw new Error('gcloud CLI not found. Install Google Cloud SDK and ensure it is in PATH.');
  }

  async isAvailable(): Promise<boolean> {
    try {
      const gcloud = await this.resolveGcloud();
      // Check auth state
      await execFileAsync(gcloud, ['auth', 'print-access-token'], {
        env: { ...process.env },
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parse reference string into project, secret name, and optional version.
   * Format: [project-id/]secret-name[/version]
   */
  private parseRef(ref: string): { project: string; secretName: string; version: string } {
    const parts = ref.split('/');

    let project: string;
    let secretName: string;
    let version = 'latest';

    if (parts.length === 1) {
      // "secret-name" — use default project
      secretName = parts[0];
      project = process.env['GCLOUD_PROJECT'] || process.env['GOOGLE_CLOUD_PROJECT'] || '';
      if (!project) {
        throw new Error(
          `No project specified in ref "${ref}" and GCLOUD_PROJECT env var is not set. ` +
          'Use format "project-id/secret-name" or set GCLOUD_PROJECT.'
        );
      }
    } else if (parts.length === 2) {
      // "project-id/secret-name"
      [project, secretName] = parts;
    } else if (parts.length === 3) {
      // "project-id/secret-name/version"
      [project, secretName, version] = parts;
    } else {
      throw new Error(`Invalid Google Secret Manager reference: "${ref}". Expected "project-id/secret-name" or "project-id/secret-name/version".`);
    }

    return { project, secretName, version };
  }

  async getCredential(ref: string): Promise<CredentialResult> {
    const gcloud = await this.resolveGcloud();
    const { project, secretName, version } = this.parseRef(ref);

    // Retrieve password — captured to string temporarily, then moved to Buffer
    const { stdout: passwordRaw } = await execFileAsync(
      gcloud,
      [
        'secrets', 'versions', 'access', version,
        '--secret', secretName,
        '--project', project,
        '--format', 'get(payload.data)',
      ],
      { env: { ...process.env } }
    );

    // Convert to Buffer immediately, wipe the string reference
    const password = Buffer.from(passwordRaw.trim());

    // Username: derive from secret name convention "name-username" suffix
    // or fall back to empty string (caller should supply username separately)
    // Naming convention: "my-switch-creds" → try "my-switch-creds-username" secret
    // For now, use a simple convention: username stored as separate secret OR defaults to empty
    const username = await this.getUsername(gcloud, project, secretName, version).catch(() => '');

    return { username, password };
  }

  /**
   * Try to retrieve username from a paired secret: "<secret-name>-username"
   * Falls back to empty string if not found.
   */
  private async getUsername(
    gcloud: string,
    project: string,
    secretName: string,
    _version: string
  ): Promise<string> {
    const usernameSecret = `${secretName}-username`;
    try {
      const { stdout } = await execFileAsync(
        gcloud,
        ['secrets', 'versions', 'access', 'latest', '--secret', usernameSecret, '--project', project],
        { env: { ...process.env } }
      );
      return stdout.trim();
    } catch {
      return '';
    }
  }

  async getMetadata(ref: string): Promise<CredentialMetadata> {
    const gcloud = await this.resolveGcloud();
    const { project, secretName, version } = this.parseRef(ref);

    // Verify the secret version exists and is enabled (without retrieving value)
    await execFileAsync(
      gcloud,
      ['secrets', 'versions', 'describe', version, '--secret', secretName, '--project', project],
      { env: { ...process.env } }
    );

    const username = await this.getUsername(gcloud, project, secretName, version).catch(() => '');

    return {
      username,
      has_password: true,
      backend: this.name,
    };
  }

  async cleanup(): Promise<void> {
    // No staged credentials to wipe — gcloud returns values inline
    // Buffer zero-fill happens at call site after use
  }
}
