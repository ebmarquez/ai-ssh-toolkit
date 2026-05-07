/**
 * Tests for CredentialMap — host→credential resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CredentialMap } from '../../src/credentials/credential-map.js';

describe('CredentialMap', () => {
  let testDir: string;
  let testFile: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `credmap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    testFile = join(testDir, 'credential-map.json');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('defaultPath()', () => {
    it('returns a path ending with credential-map.json', () => {
      const path = CredentialMap.defaultPath();
      expect(path).toMatch(/credential-map\.json$/);
    });

    it('returns platform-appropriate path', () => {
      const path = CredentialMap.defaultPath();
      if (process.platform === 'win32') {
        expect(path).toContain('ai-ssh-toolkit');
        // On Windows it should use APPDATA or AppData/Roaming
      } else {
        expect(path).toContain('.config/ai-ssh-toolkit');
      }
    });
  });

  describe('resolve() with glob patterns', () => {
    it('matches exact hostname', () => {
      writeFileSync(testFile, JSON.stringify({
        rules: [{ match: 'server1.example.com', backend: 'bitwarden', ref: 'abc' }]
      }));
      const map = new CredentialMap(testFile);
      const result = map.resolve('server1.example.com');
      expect(result).not.toBeNull();
      expect(result!.backend).toBe('bitwarden');
      expect(result!.ref).toBe('abc');
    });

    it('matches wildcard pattern *.prod.example.com', () => {
      writeFileSync(testFile, JSON.stringify({
        rules: [{ match: '*.prod.example.com', backend: 'bitwarden', ref: 'prod-cred' }]
      }));
      const map = new CredentialMap(testFile);
      expect(map.resolve('web1.prod.example.com')).not.toBeNull();
      expect(map.resolve('db.prod.example.com')!.backend).toBe('bitwarden');
    });

    it('matches prefix wildcard pattern build-*', () => {
      writeFileSync(testFile, JSON.stringify({
        rules: [{ match: 'build-*', backend: 'ssh-agent' }]
      }));
      const map = new CredentialMap(testFile);
      expect(map.resolve('build-123')).not.toBeNull();
      expect(map.resolve('build-server.local')!.backend).toBe('ssh-agent');
      expect(map.resolve('test-123')).toBeNull();
    });

    it('matches IP wildcard 10.218.191.*', () => {
      writeFileSync(testFile, JSON.stringify({
        rules: [{ match: '10.218.191.*', backend: 'env', ref: 'SW_USER:SW_PASS' }]
      }));
      const map = new CredentialMap(testFile);
      expect(map.resolve('10.218.191.5')!.backend).toBe('env');
      expect(map.resolve('10.218.192.5')).toBeNull();
    });

    it('matches catch-all * pattern', () => {
      writeFileSync(testFile, JSON.stringify({
        rules: [{ match: '*', backend: 'ssh-agent' }]
      }));
      const map = new CredentialMap(testFile);
      expect(map.resolve('anything.example.com')!.backend).toBe('ssh-agent');
    });

    it('returns null when no rule matches', () => {
      writeFileSync(testFile, JSON.stringify({
        rules: [{ match: 'specific-host', backend: 'bitwarden', ref: 'x' }]
      }));
      const map = new CredentialMap(testFile);
      expect(map.resolve('other-host')).toBeNull();
    });

    it('includes username when specified in rule', () => {
      writeFileSync(testFile, JSON.stringify({
        rules: [{ match: '*.prod.example.com', backend: 'bitwarden', ref: 'x', username: 'admin' }]
      }));
      const map = new CredentialMap(testFile);
      const result = map.resolve('web.prod.example.com');
      expect(result!.username).toBe('admin');
    });
  });

  describe('first-match-wins semantics', () => {
    it('returns the first matching rule', () => {
      writeFileSync(testFile, JSON.stringify({
        rules: [
          { match: 'web1.prod.example.com', backend: 'bitwarden', ref: 'specific' },
          { match: '*.prod.example.com', backend: 'env', ref: 'general' },
          { match: '*', backend: 'ssh-agent' },
        ]
      }));
      const map = new CredentialMap(testFile);

      const r1 = map.resolve('web1.prod.example.com');
      expect(r1!.backend).toBe('bitwarden');
      expect(r1!.ref).toBe('specific');

      const r2 = map.resolve('web2.prod.example.com');
      expect(r2!.backend).toBe('env');
      expect(r2!.ref).toBe('general');

      const r3 = map.resolve('other.example.com');
      expect(r3!.backend).toBe('ssh-agent');
    });
  });

  describe('match_regex support', () => {
    it('uses regex when match_regex is present', () => {
      writeFileSync(testFile, JSON.stringify({
        rules: [{ match: '*', match_regex: '^db-\\d+\\.internal$', backend: 'bitwarden', ref: 'db-cred' }]
      }));
      const map = new CredentialMap(testFile);
      expect(map.resolve('db-42.internal')!.backend).toBe('bitwarden');
      expect(map.resolve('db-abc.internal')).toBeNull();
    });

    it('handles invalid regex gracefully (no match)', () => {
      writeFileSync(testFile, JSON.stringify({
        rules: [{ match: '*', match_regex: '[invalid', backend: 'bitwarden', ref: 'x' }]
      }));
      const map = new CredentialMap(testFile);
      expect(map.resolve('anything')).toBeNull();
    });
  });

  describe('reload()', () => {
    it('re-reads the file from disk', () => {
      writeFileSync(testFile, JSON.stringify({
        rules: [{ match: '*', backend: 'ssh-agent' }]
      }));
      const map = new CredentialMap(testFile);
      expect(map.resolve('host1')!.backend).toBe('ssh-agent');

      // Update the file
      writeFileSync(testFile, JSON.stringify({
        rules: [{ match: '*', backend: 'bitwarden', ref: 'new-ref' }]
      }));
      map.reload();
      expect(map.resolve('host1')!.backend).toBe('bitwarden');
      expect(map.resolve('host1')!.ref).toBe('new-ref');
    });
  });

  describe('error handling', () => {
    it('handles missing file gracefully (no crash, resolve returns null)', () => {
      const map = new CredentialMap('/nonexistent/path/credential-map.json');
      expect(map.resolve('any-host')).toBeNull();
    });

    it('handles invalid JSON gracefully (no crash, resolve returns null)', () => {
      writeFileSync(testFile, 'not valid json {{{}');
      const map = new CredentialMap(testFile);
      expect(map.resolve('any-host')).toBeNull();
    });

    it('handles JSON without rules array gracefully', () => {
      writeFileSync(testFile, JSON.stringify({ something: 'else' }));
      const map = new CredentialMap(testFile);
      expect(map.resolve('any-host')).toBeNull();
    });
  });

  describe('case insensitivity', () => {
    it('matches patterns case-insensitively', () => {
      writeFileSync(testFile, JSON.stringify({
        rules: [{ match: '*.Example.COM', backend: 'bitwarden', ref: 'x' }]
      }));
      const map = new CredentialMap(testFile);
      expect(map.resolve('host.example.com')).not.toBeNull();
      expect(map.resolve('HOST.EXAMPLE.COM')).not.toBeNull();
    });
  });
});
