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

/** Internal representation with pre-compiled regex for performance and ReDoS mitigation. */
interface CompiledRule {
  rule: CredentialMapRule;
  regex: RegExp;
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
  /** Index of the matched rule in the rules array */
  matched_rule_index?: number;
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
  private compiledRules: CompiledRule[] = [];
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
    for (let i = 0; i < this.compiledRules.length; i++) {
      const { rule, regex } = this.compiledRules[i];
      // ReDoS note: regex is pre-compiled at load time. User-supplied patterns
      // could still be expensive; consider restricting pattern complexity in docs.
      try {
        if (regex.test(host)) {
          return {
            backend: rule.backend,
            ref: rule.ref,
            username: rule.username,
            matched_rule: rule,
            matched_rule_index: i,
          };
        }
      } catch {
        // Skip rules whose regex throws (should not happen with pre-compiled, but defensive)
        continue;
      }
    }
    return null;
  }

  /** Get loaded rules (for diagnostics) */
  getRules(): ReadonlyArray<CredentialMapRule> {
    return this.compiledRules.map(cr => cr.rule);
  }

  /** Get the config file path */
  getFilePath(): string {
    return this.filePath;
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as CredentialMapFile;
      if (Array.isArray(parsed.rules)) {
        // Validate: skip entries missing required fields
        const validRules = parsed.rules.filter(
          (r): r is CredentialMapRule =>
            typeof r.match === 'string' && typeof r.backend === 'string'
        );
        // Pre-compile all regexes at load time to avoid per-resolve overhead
        this.compiledRules = [];
        for (const rule of validRules) {
          try {
            const regex = rule.match_regex
              ? new RegExp(rule.match_regex, 'i')
              : globToRegex(rule.match);
            this.compiledRules.push({ rule, regex });
          } catch {
            // Skip rules with invalid regex patterns
          }
        }
      } else {
        this.compiledRules = [];
      }
    } catch {
      // Missing file or invalid JSON — silent no-op
      this.compiledRules = [];
    }
  }
}
