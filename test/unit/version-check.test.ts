import { beforeEach, describe, expect, it } from 'vitest';
import { clearVersionCheckCache, versionCheck } from '../../src/tools/version-check.js';

describe('versionCheck', () => {
  beforeEach(() => {
    clearVersionCheckCache();
  });

  it('reports up to date when current matches latest', async () => {
    const result = await versionCheck(async () => '0.1.0', 1_000);
    expect(result.current).toBe('0.1.0');
    expect(result.latest).toBe('0.1.0');
    expect(result.up_to_date).toBe(true);
    expect(result.update_available).toBe(false);
    expect(result.source).toBe('npm');
  });

  it('reports update available when latest differs', async () => {
    const result = await versionCheck(async () => '0.1.9', 2_000);
    expect(result.current).toBe('0.1.0');
    expect(result.latest).toBe('0.1.9');
    expect(result.up_to_date).toBe(false);
    expect(result.update_available).toBe(true);
    expect(result.upgrade_hint).toContain('npm install -g ai-ssh-toolkit@latest');
  });

  it('returns unavailable state when npm lookup fails', async () => {
    const result = await versionCheck(async () => {
      throw new Error('network down');
    }, 3_000);
    expect(result.current).toBe('0.1.0');
    expect(result.latest).toBeNull();
    expect(result.up_to_date).toBeNull();
    expect(result.update_available).toBeNull();
    expect(result.source).toBe('unavailable');
    expect(result.error).toContain('network down');
  });

  it('uses cache within ttl', async () => {
    let calls = 0;
    const fetchLatest = async () => {
      calls += 1;
      return '0.1.2';
    };

    const first = await versionCheck(fetchLatest, 10_000);
    const second = await versionCheck(async () => {
      calls += 1;
      return '9.9.9';
    }, 10_500);

    expect(first.latest).toBe('0.1.2');
    expect(second.latest).toBe('0.1.2');
    expect(second.source).toBe('cache');
    expect(calls).toBe(1);
  });
});
