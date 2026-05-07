/**
 * Unit tests for ssh-list-hosts.ts
 * Mocks filesystem reads to test SSH config parsing, Include expansion,
 * glob filtering, and sensitive field exclusion.
 */

import { describe, it, expect, vi } from 'vitest';
import { sshListHosts, type FsLike, type SshHostEntry } from '../../src/tools/ssh-list-hosts.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const HOME = '/home/testuser';
const SSH_DIR = `${HOME}/.ssh`;
const CONFIG = `${SSH_DIR}/config`;

/** Build a mock filesystem from a map of path → content. */
function mockFs(files: Record<string, string>, dirs: Record<string, string[]> = {}): FsLike {
  return {
    readFile: vi.fn(async (path: string) => {
      if (path in files) return files[path];
      const err = new Error(`ENOENT: no such file: ${path}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }),
    readdir: vi.fn(async (path: string) => {
      if (path in dirs) return dirs[path];
      const err = new Error(`ENOENT: no such directory: ${path}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }),
    realpath: vi.fn(async (path: string) => {
      // If the file exists in our map, return the path as-is (simulating realpath)
      if (path in files) return path;
      const err = new Error(`ENOENT: no such file: ${path}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }),
  };
}

function findHost(hosts: SshHostEntry[], alias: string): SshHostEntry | undefined {
  return hosts.find((h) => h.alias === alias);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('sshListHosts', () => {
  it('parses basic Host entries with HostName, User, Port', async () => {
    const fs = mockFs({
      [CONFIG]: `
Host web-prod
  HostName 10.0.1.1
  User deploy
  Port 2222

Host db-prod
  HostName 10.0.2.1
  User admin
`,
    });

    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts).toHaveLength(2);
    const web = findHost(result.hosts, 'web-prod')!;
    expect(web.hostname).toBe('10.0.1.1');
    expect(web.user).toBe('deploy');
    expect(web.port).toBe(2222);
    expect(web.source).toBe('~/.ssh/config');

    const db = findHost(result.hosts, 'db-prod')!;
    expect(db.hostname).toBe('10.0.2.1');
    expect(db.user).toBe('admin');
    expect(db.port).toBeUndefined();
  });

  it('excludes IdentityFile, ProxyJump, ProxyCommand, and other sensitive fields', async () => {
    const fs = mockFs({
      [CONFIG]: `
Host secure-box
  HostName secure.example.com
  User root
  IdentityFile ~/.ssh/secret_key
  ProxyJump bastion.example.com
  ProxyCommand ssh -W %h:%p bastion
  ForwardAgent yes
  LocalForward 8080 localhost:80
`,
    });

    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts).toHaveLength(1);
    const host = result.hosts[0];
    expect(host.alias).toBe('secure-box');
    expect(host.hostname).toBe('secure.example.com');
    expect(host.user).toBe('root');
    // Sensitive fields should NOT appear in the output
    expect(host).not.toHaveProperty('identityFile');
    expect(host).not.toHaveProperty('proxyJump');
    expect(host).not.toHaveProperty('proxyCommand');
    expect(host).not.toHaveProperty('forwardAgent');
    // Only known safe fields (port is also safe but undefined here)
    const keys = Object.keys(host).sort();
    for (const k of keys) {
      expect(['alias', 'hostname', 'user', 'port', 'source']).toContain(k);
    }
  });

  it('skips wildcard-only Host entries like Host *', async () => {
    const fs = mockFs({
      [CONFIG]: `
Host *
  User default-user
  ServerAliveInterval 60

Host app-server
  HostName app.example.com
`,
    });

    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0].alias).toBe('app-server');
  });

  it('skips hosts with glob metacharacters (* ? [ ])', async () => {
    const fs = mockFs({
      [CONFIG]: `
Host prod-*
  User deploy

Host dev-?
  User developer

Host staging[1-3]
  User staging

Host concrete-host
  HostName concrete.example.com
`,
    });

    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0].alias).toBe('concrete-host');
  });

  it('skips negated patterns (Host !bad-host)', async () => {
    const fs = mockFs({
      [CONFIG]: `
Host good-host !bad-host
  HostName good.example.com
`,
    });

    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0].alias).toBe('good-host');
  });

  it('handles multiple aliases in a single Host line', async () => {
    const fs = mockFs({
      [CONFIG]: `
Host alpha bravo charlie
  HostName shared.example.com
  User ops
  Port 22
`,
    });

    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts).toHaveLength(3);
    for (const alias of ['alpha', 'bravo', 'charlie']) {
      const h = findHost(result.hosts, alias)!;
      expect(h.hostname).toBe('shared.example.com');
      expect(h.user).toBe('ops');
    }
  });

  it('filters by glob pattern', async () => {
    const fs = mockFs({
      [CONFIG]: `
Host prod-web
  HostName 10.0.1.1

Host prod-db
  HostName 10.0.2.1

Host staging-web
  HostName 10.1.1.1
`,
    });

    const result = await sshListHosts({ pattern: 'prod-*' }, fs, HOME);

    expect(result.hosts).toHaveLength(2);
    expect(result.hosts.map((h) => h.alias)).toEqual(['prod-db', 'prod-web']);
  });

  it('returns empty array when pattern matches nothing', async () => {
    const fs = mockFs({
      [CONFIG]: `
Host app-server
  HostName app.example.com
`,
    });

    const result = await sshListHosts({ pattern: 'nope-*' }, fs, HOME);
    expect(result.hosts).toHaveLength(0);
  });

  it('follows Include directives', async () => {
    const fs = mockFs({
      [CONFIG]: `Include conf.d/prod.conf\n\nHost local\n  HostName localhost\n`,
      [`${SSH_DIR}/conf.d/prod.conf`]: `
Host prod-app
  HostName prod.example.com
  User deploy
`,
    });

    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts).toHaveLength(2);
    const prodApp = findHost(result.hosts, 'prod-app')!;
    expect(prodApp.hostname).toBe('prod.example.com');
    expect(prodApp.source).toBe('~/.ssh/conf.d/prod.conf');

    const local = findHost(result.hosts, 'local')!;
    expect(local.hostname).toBe('localhost');
    expect(local.source).toBe('~/.ssh/config');
  });

  it('follows Include with glob patterns', async () => {
    const fs = mockFs(
      {
        [CONFIG]: `Include conf.d/*\n`,
        [`${SSH_DIR}/conf.d/a.conf`]: `Host alpha\n  HostName alpha.example.com\n`,
        [`${SSH_DIR}/conf.d/b.conf`]: `Host bravo\n  HostName bravo.example.com\n`,
      },
      {
        [`${SSH_DIR}/conf.d`]: ['a.conf', 'b.conf'],
      },
    );

    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts).toHaveLength(2);
    expect(findHost(result.hosts, 'alpha')!.hostname).toBe('alpha.example.com');
    expect(findHost(result.hosts, 'bravo')!.hostname).toBe('bravo.example.com');
  });

  it('follows Include with absolute path', async () => {
    const fs = mockFs({
      [CONFIG]: `Include /etc/ssh/extra.conf\n`,
      ['/etc/ssh/extra.conf']: `Host external\n  HostName ext.example.com\n`,
    });

    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0].alias).toBe('external');
    expect(result.hosts[0].source).toBe('/etc/ssh/extra.conf');
  });

  it('follows Include with tilde path', async () => {
    const fs = mockFs({
      [CONFIG]: `Include ~/.ssh/extra.conf\n`,
      [`${SSH_DIR}/extra.conf`]: `Host tilde-host\n  HostName tilde.example.com\n`,
    });

    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0].alias).toBe('tilde-host');
  });

  it('handles Include cycle detection', async () => {
    const fs = mockFs({
      [CONFIG]: `Include other.conf\nHost main\n  HostName main.example.com\n`,
      [`${SSH_DIR}/other.conf`]: `Include ${CONFIG}\nHost other\n  HostName other.example.com\n`,
    });

    // Should not hang or throw — cycles are detected
    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts.length).toBeGreaterThanOrEqual(2);
    expect(findHost(result.hosts, 'main')).toBeDefined();
    expect(findHost(result.hosts, 'other')).toBeDefined();
  });

  it('returns empty hosts when config file does not exist', async () => {
    const fs = mockFs({});

    const result = await sshListHosts({}, fs, HOME);
    expect(result.hosts).toHaveLength(0);
  });

  it('handles case-insensitive keywords', async () => {
    const fs = mockFs({
      [CONFIG]: `
HOST myserver
  HOSTNAME myserver.example.com
  user admin
  PORT 3022
`,
    });

    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts).toHaveLength(1);
    const h = result.hosts[0];
    expect(h.alias).toBe('myserver');
    expect(h.hostname).toBe('myserver.example.com');
    expect(h.user).toBe('admin');
    expect(h.port).toBe(3022);
  });

  it('handles Keyword=value syntax', async () => {
    const fs = mockFs({
      [CONFIG]: `
Host eq-host
  HostName=eq.example.com
  User=equser
  Port=4422
`,
    });

    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts).toHaveLength(1);
    const h = result.hosts[0];
    expect(h.hostname).toBe('eq.example.com');
    expect(h.user).toBe('equser');
    expect(h.port).toBe(4422);
  });

  it('strips inline comments', async () => {
    const fs = mockFs({
      [CONFIG]: `
Host comment-host # this is a comment
  HostName comment.example.com # also a comment
  User admin
`,
    });

    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts).toHaveLength(1);
    const h = result.hosts[0];
    expect(h.alias).toBe('comment-host');
    expect(h.hostname).toBe('comment.example.com');
  });

  it('does not attach Match block directives to prior Host block', async () => {
    const fs = mockFs({
      [CONFIG]: `
Host app
  HostName app.example.com

Match user deploy
  Port 2222
`,
    });

    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts).toHaveLength(1);
    const h = result.hosts[0];
    expect(h.alias).toBe('app');
    expect(h.port).toBeUndefined();
  });

  it('deduplicates aliases keeping first occurrence', async () => {
    const fs = mockFs({
      [CONFIG]: `
Host dupe
  HostName first.example.com

Host dupe
  HostName second.example.com
`,
    });

    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0].hostname).toBe('first.example.com');
  });

  it('validates port range (ignores invalid ports)', async () => {
    const fs = mockFs({
      [CONFIG]: `
Host bad-port
  HostName bad.example.com
  Port 99999

Host bad-port2
  HostName bad2.example.com
  Port abc

Host good-port
  HostName good.example.com
  Port 443
`,
    });

    const result = await sshListHosts({}, fs, HOME);

    expect(findHost(result.hosts, 'bad-port')!.port).toBeUndefined();
    expect(findHost(result.hosts, 'bad-port2')!.port).toBeUndefined();
    expect(findHost(result.hosts, 'good-port')!.port).toBe(443);
  });

  it('uses first-value-wins for HostName/User/Port within a block', async () => {
    const fs = mockFs({
      [CONFIG]: `
Host multi-val
  HostName first.example.com
  HostName second.example.com
  User firstuser
  User seconduser
  Port 22
  Port 2222
`,
    });

    const result = await sshListHosts({}, fs, HOME);

    const h = result.hosts[0];
    expect(h.hostname).toBe('first.example.com');
    expect(h.user).toBe('firstuser');
    expect(h.port).toBe(22);
  });

  it('sorts results by alias', async () => {
    const fs = mockFs({
      [CONFIG]: `
Host zebra
  HostName z.example.com
Host apple
  HostName a.example.com
Host mango
  HostName m.example.com
`,
    });

    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts.map((h) => h.alias)).toEqual(['apple', 'mango', 'zebra']);
  });

  it('pattern with ? matches single character', async () => {
    const fs = mockFs({
      [CONFIG]: `
Host app1
  HostName app1.example.com
Host app2
  HostName app2.example.com
Host app10
  HostName app10.example.com
`,
    });

    const result = await sshListHosts({ pattern: 'app?' }, fs, HOME);

    expect(result.hosts).toHaveLength(2);
    expect(result.hosts.map((h) => h.alias)).toEqual(['app1', 'app2']);
  });

  it('pattern escapes regex special characters (dots)', async () => {
    const fs = mockFs({
      [CONFIG]: `
Host prod.web
  HostName prod-web.example.com
Host prodXweb
  HostName prodX-web.example.com
`,
    });

    const result = await sshListHosts({ pattern: 'prod.web' }, fs, HOME);

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0].alias).toBe('prod.web');
  });

  it('handles host with no extra directives', async () => {
    const fs = mockFs({
      [CONFIG]: `Host bare-host\n`,
    });

    const result = await sshListHosts({}, fs, HOME);

    expect(result.hosts).toHaveLength(1);
    const h = result.hosts[0];
    expect(h.alias).toBe('bare-host');
    expect(h.hostname).toBeUndefined();
    expect(h.user).toBeUndefined();
    expect(h.port).toBeUndefined();
  });
});
