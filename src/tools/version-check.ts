import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 60 * 60 * 1000;
const PACKAGE_NAME = 'ai-ssh-toolkit';

export interface VersionCheckResult {
  current: string;
  latest: string | null;
  up_to_date: boolean | null;
  update_available: boolean | null;
  upgrade_hint: string;
  checked_at: string;
  source: 'npm' | 'cache' | 'unavailable';
  error?: string;
}

let cachedResult: VersionCheckResult | null = null;
let cachedAt = 0;

async function getCurrentVersion(): Promise<string> {
  const packageJsonPath = new URL('../../package.json', import.meta.url);
  const raw = await readFile(packageJsonPath, 'utf-8');
  const pkg = JSON.parse(raw) as { version?: string };
  if (!pkg.version) {
    throw new Error('Unable to determine installed package version');
  }
  return pkg.version;
}

async function fetchLatestPublishedVersion(): Promise<string> {
  const { stdout } = await execFileAsync('npm', ['view', PACKAGE_NAME, 'version', '--json'], {
    timeout: 10000,
    encoding: 'utf-8',
  });

  const parsed = JSON.parse(stdout.trim()) as string;
  if (!parsed || typeof parsed !== 'string') {
    throw new Error('Invalid npm version response');
  }
  return parsed;
}

function compareVersions(current: string, latest: string): { up_to_date: boolean; update_available: boolean } {
  return {
    up_to_date: current === latest,
    update_available: current !== latest,
  };
}

export function clearVersionCheckCache(): void {
  cachedResult = null;
  cachedAt = 0;
}

export async function versionCheck(
  fetchLatest: () => Promise<string> = fetchLatestPublishedVersion,
  nowMs: number = Date.now(),
): Promise<VersionCheckResult> {
  const current = await getCurrentVersion();
  const checked_at = new Date(nowMs).toISOString();

  if (cachedResult && nowMs - cachedAt < CACHE_TTL_MS) {
    return {
      ...cachedResult,
      current,
      checked_at,
      source: 'cache',
    };
  }

  try {
    const latest = await fetchLatest();
    const comparison = compareVersions(current, latest);
    const result: VersionCheckResult = {
      current,
      latest,
      ...comparison,
      upgrade_hint: `npm install -g ${PACKAGE_NAME}@latest`,
      checked_at,
      source: 'npm',
    };
    cachedResult = result;
    cachedAt = nowMs;
    return result;
  } catch (err: unknown) {
    const result: VersionCheckResult = {
      current,
      latest: null,
      up_to_date: null,
      update_available: null,
      upgrade_hint: `npm install -g ${PACKAGE_NAME}@latest`,
      checked_at,
      source: 'unavailable',
      error: err instanceof Error ? err.message : String(err),
    };
    cachedResult = result;
    cachedAt = nowMs;
    return result;
  }
}
