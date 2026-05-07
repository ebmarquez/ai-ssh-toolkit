/**
 * CredentialMap — host→credential resolution via a JSON rules file.
 *
 * Loads rules from a JSON config file and resolves hosts to credential
 * backend+ref using first-match-wins semantics with glob or regex patterns.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { platform, homedir } from 'os';

export interface CredentialMapRule {
  match: string;
  match_regex?: string;
  backend: string;
  ref?: string;
  username?: string;
}

export interface CredentialMapFile {
  rules: CredentialMapRule[];
}

export interface CredentialMapResult {
  backend: string;
  ref?: string;
  username?: string;
  /** The rule that matched (for diagnostics) */
  matched_rule?: CredentialMapRule;
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: * (anything), ? (single char). Escapes other regex chars.
 */
function globToRegex(pattern: string): RegExp {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      regex += '.*';
    } else if (ch === '?') {
      regex += '.';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regex += '\\' + ch;
    } else {
      regex += ch;
    }
  }
  return new RegExp('^' + regex + '$', 'i');
}

export class CredentialMap {
  private rules: CredentialMapRule[] = [];
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? CredentialMap.defaultPath();
    this.load();
  }

  /** Platform-appropriate default config path */
  static defaultPath(): string {
    if (platform() === 'win32') {
      const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
      return join(appData, 'ai-ssh-toolkit', 'credential-map.json');
    }
    return join(homedir(), '.config', 'ai-ssh-toolkit', 'credential-map.json');
  }

  /** Load (or reload) rules from the config file. Silent no-op on missing/invalid file. */
  reload(): void {
    this.load();
  }

  /** Resolve a host to a credential backend+ref. Returns null if no rule matches. */
  resolve(host: string): CredentialMapResult | null {
    for (const rule of this.rules) {
      if (this.matches(rule, host)) {
        return {
          backend: rule.backend,
          ref: rule.ref,
          username: rule.username,
          matched_rule: rule,
        };
      }
    }
    return null;
  }

  /** Get loaded rules (for diagnostics) */
  getRules(): ReadonlyArray<CredentialMapRule> {
    return this.rules;
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as CredentialMapFile;
      if (Array.isArray(parsed.rules)) {
        this.rules = parsed.rules;
      } else {
        this.rules = [];
      }
    } catch {
      // Missing file or invalid JSON — silent no-op
      this.rules = [];
    }
  }

  private matches(rule: CredentialMapRule, host: string): boolean {
    if (rule.match_regex) {
      try {
        const re = new RegExp(rule.match_regex, 'i');
        return re.test(host);
      } catch {
        return false;
      }
    }
    const re = globToRegex(rule.match);
    return re.test(host);
  }
}
