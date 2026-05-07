/**
 * credential_diagnose tool handler — shows which credential map rule
 * matches a given host and whether the backend is available.
 */

import type { CredentialRegistry } from '../credentials/registry.js';
import type { CredentialMap } from '../credentials/credential-map.js';

export interface CredentialDiagnoseInput {
  host: string;
}

export interface CredentialDiagnoseResult {
  host: string;
  matched_rule: {
    match: string;
    match_regex?: string;
    backend: string;
    ref?: string;
    username?: string;
  } | null;
  matched_rule_index: number | null;
  backend_available: boolean;
}

export async function credentialDiagnose(
  registry: CredentialRegistry,
  input: CredentialDiagnoseInput,
  credentialMap: CredentialMap,
): Promise<CredentialDiagnoseResult> {
  const { host } = input;
  if (!host) throw new Error('host is required');

  const resolved = credentialMap.resolve(host);

  if (!resolved || !resolved.matched_rule) {
    return {
      host,
      matched_rule: null,
      matched_rule_index: null,
      backend_available: false,
    };
  }

  let backendAvailable = false;
  try {
    const backend = registry.getBackend(resolved.backend);
    backendAvailable = await backend.isAvailable();
  } catch {
    backendAvailable = false;
  }

  return {
    host,
    matched_rule: {
      match: resolved.matched_rule.match,
      match_regex: resolved.matched_rule.match_regex,
      backend: resolved.matched_rule.backend,
      ref: resolved.matched_rule.ref,
      username: resolved.matched_rule.username,
    },
    matched_rule_index: resolved.matched_rule_index ?? null,
    backend_available: backendAvailable,
  };
}
