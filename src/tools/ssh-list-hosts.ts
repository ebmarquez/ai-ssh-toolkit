/**
 * ssh_list_hosts tool handler — enumerates Host entries from ~/.ssh/config
 * (including Include directives) and returns a sanitized inventory.
 *
 * Only exposes: alias, hostname, user, port, source file.
 * Excludes: IdentityFile, ProxyJump, ProxyCommand, and all other sensitive directives.
 */

import { readFile, readdir, realpath } from 'fs/promises';
import { join, dirname, isAbsolute } from 'path';
import { homedir } from 'os';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SshHostEntry {
  alias: string;
  hostname?: string;
  user?: string;
  port?: number;
  source: string;
}

export interface SshListHostsInput {
  pattern?: string;
}

export interface SshListHostsResult {
  hosts: SshHostEntry[];
}

/** Abstraction over filesystem operations for testability. */
export interface FsLike {
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  readdir(path: string): Promise<string[]>;
  realpath(path: string): Promise<string>;
}

const defaultFs: FsLike = {
  readFile: (p, enc) => readFile(p, enc),
  readdir: (p) => readdir(p),
  realpath: (p) => realpath(p),
};

// ── Glob pattern matching ───────────────────────────────────────────────────

/** Returns true if `alias` contains SSH glob metacharacters (* ? [ ]). */
function isWildcardPattern(alias: string): boolean {
  return /[*?[\]]/.test(alias);
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Escapes regex metacharacters, then maps `*` → `.*` and `?` → `.`.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`);
}

// ── SSH config parsing ──────────────────────────────────────────────────────

/**
 * Strip inline comments: everything after an unquoted `#`.
 * A `#` preceded by whitespace (or at start) is a comment.
 */
function stripComment(line: string): string {
  // Leading comment
  if (line.trimStart().startsWith('#')) return '';

  // Inline comment: # preceded by whitespace and not inside quotes
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inQuote = !inQuote;
    } else if (line[i] === '#' && !inQuote && i > 0 && /\s/.test(line[i - 1])) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Parse a keyword and value from an SSH config line.
 * Handles both `Keyword value` and `Keyword=value` syntax.
 * Returns null for empty/comment lines.
 */
function parseConfigLine(raw: string): { keyword: string; value: string } | null {
  const line = stripComment(raw).trim();
  if (!line) return null;

  // Split on first whitespace or '='
  const match = line.match(/^(\S+?)(?:\s*=\s*|\s+)(.+)$/);
  if (!match) return null;

  return { keyword: match[1].toLowerCase(), value: match[2].trim() };
}

/**
 * Expand ~ to the user's home directory.
 */
function expandTilde(p: string, home: string): string {
  if (p.startsWith('~/')) return join(home, p.slice(2));
  if (p === '~') return home;
  return p;
}

/**
 * Expand a glob pattern in a directory, returning matching file paths (sorted).
 * Handles simple `*` wildcards in the last path segment.
 */
async function expandIncludeGlob(
  pattern: string,
  sshDir: string,
  home: string,
  fs: FsLike,
): Promise<string[]> {
  const expanded = expandTilde(pattern, home);
  const full = isAbsolute(expanded) ? expanded : join(sshDir, expanded);

  const dir = dirname(full);
  const base = full.slice(dir.length + 1);

  // If no glob chars, return as-is
  if (!isWildcardPattern(base)) {
    return [full];
  }

  const regex = globToRegex(base);
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((e) => regex.test(e))
      .sort()
      .map((e) => join(dir, e));
  } catch {
    // Directory not found — no matches
    return [];
  }
}

interface ParseContext {
  fs: FsLike;
  home: string;
  sshDir: string;
  visited: Set<string>;
  maxDepth: number;
}

/**
 * Parse a single SSH config file and return host entries.
 * Follows Include directives recursively with cycle detection.
 */
async function parseSshConfigFile(
  filePath: string,
  ctx: ParseContext,
  depth: number,
): Promise<SshHostEntry[]> {
  if (depth > ctx.maxDepth) return [];

  let resolvedPath: string;
  try {
    resolvedPath = await ctx.fs.realpath(filePath);
  } catch {
    // File doesn't exist
    return [];
  }

  if (ctx.visited.has(resolvedPath)) return [];
  ctx.visited.add(resolvedPath);

  let content: string;
  try {
    content = await ctx.fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const hosts: SshHostEntry[] = [];
  let currentBlock: {
    aliases: string[];
    hostname?: string;
    user?: string;
    port?: number;
    source: string;
  } | null = null;

  // Relative path for source display
  const sourceDisplay = filePath.startsWith(ctx.home + '/')
    ? '~/' + filePath.slice(ctx.home.length + 1)
    : filePath;

  const flushBlock = () => {
    if (!currentBlock) return;
    for (const alias of currentBlock.aliases) {
      hosts.push({
        alias,
        hostname: currentBlock.hostname,
        user: currentBlock.user,
        port: currentBlock.port,
        source: currentBlock.source,
      });
    }
    currentBlock = null;
  };

  const lines = content.split('\n');
  for (const rawLine of lines) {
    const parsed = parseConfigLine(rawLine);
    if (!parsed) continue;

    const { keyword, value } = parsed;

    if (keyword === 'host') {
      flushBlock();

      // Split Host value into individual patterns, filtering wildcards and negations
      const aliases = value
        .split(/\s+/)
        .filter((a) => a && !isWildcardPattern(a) && !a.startsWith('!'));

      if (aliases.length > 0) {
        currentBlock = { aliases, source: sourceDisplay };
      }
    } else if (keyword === 'match') {
      // Match block — stop accumulating into current Host block
      flushBlock();
    } else if (keyword === 'include') {
      flushBlock();
      // Include may specify multiple patterns separated by whitespace
      const patterns = value.split(/\s+/).filter(Boolean);
      for (const pattern of patterns) {
        const files = await expandIncludeGlob(pattern, ctx.sshDir, ctx.home, ctx.fs);
        for (const file of files) {
          const included = await parseSshConfigFile(file, ctx, depth + 1);
          hosts.push(...included);
        }
      }
    } else if (currentBlock) {
      // Only capture safe fields
      switch (keyword) {
        case 'hostname':
          currentBlock.hostname ??= value;
          break;
        case 'user':
          currentBlock.user ??= value;
          break;
        case 'port': {
          if (currentBlock.port === undefined) {
            const p = /^\d+$/.test(value) ? parseInt(value, 10) : NaN;
            if (Number.isFinite(p) && p >= 1 && p <= 65535) {
              currentBlock.port = p;
            }
          }
          break;
        }
        // All other directives (IdentityFile, ProxyJump, etc.) are intentionally ignored
      }
    }
  }

  flushBlock();
  return hosts;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * List SSH host entries from ~/.ssh/config.
 *
 * @param input - Optional pattern to filter aliases (glob syntax: `*`, `?`).
 * @param fs - Filesystem abstraction for testing.
 * @param homeDir - Override home directory for testing.
 */
export async function sshListHosts(
  input: SshListHostsInput,
  fs: FsLike = defaultFs,
  homeDir?: string,
): Promise<SshListHostsResult> {
  const home = homeDir ?? homedir();
  const sshDir = join(home, '.ssh');
  const configPath = join(sshDir, 'config');

  const ctx: ParseContext = {
    fs,
    home,
    sshDir,
    visited: new Set(),
    maxDepth: 10,
  };

  const hosts = await parseSshConfigFile(configPath, ctx, 0);

  // Deduplicate by alias (first occurrence wins, matching SSH semantics)
  const seen = new Set<string>();
  const deduped: SshHostEntry[] = [];
  for (const h of hosts) {
    if (!seen.has(h.alias)) {
      seen.add(h.alias);
      deduped.push(h);
    }
  }

  // Apply glob filter if pattern provided
  let result = deduped;
  if (input.pattern) {
    const regex = globToRegex(input.pattern);
    result = deduped.filter((h) => regex.test(h.alias));
  }

  // Sort by alias for deterministic output
  result.sort((a, b) => a.alias.localeCompare(b.alias));

  return { hosts: result };
}
