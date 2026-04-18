import { beforeEach, describe, expect, it } from 'vitest';
import { clearVersionCheckCache, versionCheck } from '../../src/tools/version-check.js';

describe('versionCheck', () => {
  beforeEach(() => {
    clearVersionCheckCache();
  });

  it('reports up to date when current matches latest', async () => {
    const result = await versionCheck(async () => '1.2.3', 1_000, async () => '1.2.3');
    expect(result.current).toBe('1.2.3');
    expect(result.latest).toBe('1.2.3');
    expect(result.up_to_date).toBe(true);
    expect(result.update_available).toBe(false);
    expect(result.source).toBe('npm');
  });

  it('reports update available when latest is greater than current', async () => {
    const result = await versionCheck(async () => '1.2.9', 2_000, async () => '1.2.3');
    expect(result.current).toBe('1.2.3');
    expect(result.latest).toBe('1.2.9');
    expect(result.up_to_date).toBe(false);
    expect(result.update_available).toBe(true);
    expect(result.upgrade_hint).toContain('npm install -g ai-ssh-toolkit@latest');
  });

  it('does not report update available when current is newer than latest', async () => {
    const result = await versionCheck(async () => '1.2.2', 2_500, async () => '1.2.3-beta.1');
    expect(result.up_to_date).toBe(false);
    expect(result.update_available).toBe(false);
  });

  it('returns unavailable state when npm lookup fails', async () => {
    const result = await versionCheck(async () => {
      throw new Error('network down');
    }, 3_000, async () => '1.2.3');
    expect(result.current).toBe('1.2.3');
    expect(result.latest).toBeNull();
    expect(result.up_to_date).toBeNull();
    expect(result.update_available).toBeNull();
    expect(result.source).toBe('unavailable');
    expect(result.error).toContain('network down');
  });

  it('uses cache within ttl and recomputes flags against fresh current version', async () => {
    let calls = 0;
    const fetchLatest = async () => {
      calls += 1;
      return '1.2.2';
    };

    const first = await versionCheck(fetchLatest, 10_000, async () => '1.2.0');
    const second = await versionCheck(async () => {
      calls += 1;
      return '9.9.9';
    }, 10_500, async () => '1.2.3');

    expect(first.latest).toBe('1.2.2');
    expect(second.latest).toBe('1.2.2');
    expect(second.current).toBe('1.2.3');
    expect(second.up_to_date).toBe(false);
    expect(second.update_available).toBe(false);
    expect(second.source).toBe('cache');
    expect(calls).toBe(1);
  });
});
