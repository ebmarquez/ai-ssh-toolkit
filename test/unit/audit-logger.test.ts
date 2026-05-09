import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AuditLogger, AuditRecord, sha256 } from '../../src/audit/audit-logger.js';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('AuditLogger', () => {
  // ── sha256 ──────────────────────────────────────────────────────────────
  describe('sha256', () => {
    it('returns consistent hex digest', () => {
      const hash = sha256('ls -la');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256('ls -la')).toBe(hash);
    });

    it('returns different hashes for different inputs', () => {
      expect(sha256('ls')).not.toBe(sha256('pwd'));
    });
  });

  // ── AuditRecord shape ──────────────────────────────────────────────────
  describe('record shape', () => {
    it('emitted record has all required fields', () => {
      const records: AuditRecord[] = [];
      const logger = new AuditLogger({
        stdout: true,
        hashCommands: true,
        stdoutWriter: (line) => records.push(JSON.parse(line)),
      });

      logger.log({
        tool: 'ssh_execute',
        host: '10.0.0.1',
        username: 'admin',
        credential_backend: 'env',
        command: 'show version',
        exit_code: 0,
        duration_ms: 123,
        stdout_bytes: 456,
        stderr_bytes: 0,
        success: true,
      });

      expect(records).toHaveLength(1);
      const r = records[0];

      // Verify all required fields exist with correct types
      expect(r.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(r.tool).toBe('ssh_execute');
      expect(r.host).toBe('10.0.0.1');
      expect(r.username).toBe('admin');
      expect(r.credential_backend).toBe('env');
      expect(r.command_hash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hash
      expect(r.exit_code).toBe(0);
      expect(r.duration_ms).toBe(123);
      expect(r.stdout_bytes).toBe(456);
      expect(r.stderr_bytes).toBe(0);
      expect(r.success).toBe(true);
    });

    it('uses null for optional fields when not provided', () => {
      const records: AuditRecord[] = [];
      const logger = new AuditLogger({
        stdout: true,
        stdoutWriter: (line) => records.push(JSON.parse(line)),
      });

      logger.log({
        tool: 'ssh_session_open',
        host: 'server1',
        username: 'user',
        duration_ms: 50,
        success: true,
      });

      const r = records[0];
      expect(r.credential_backend).toBeNull();
      expect(r.command_hash).toBeNull();
      expect(r.exit_code).toBeNull();
      expect(r.stdout_bytes).toBeNull();
      expect(r.stderr_bytes).toBeNull();
    });
  });

  // ── No credential leakage ──────────────────────────────────────────────
  describe('no credential leakage', () => {
    it('never includes password in audit record', () => {
      const lines: string[] = [];
      const logger = new AuditLogger({
        stdout: true,
        hashCommands: true,
        stdoutWriter: (line) => lines.push(line),
      });

      logger.log({
        tool: 'ssh_execute',
        host: 'host1',
        username: 'admin',
        credential_backend: 'bitwarden',
        command: 'echo SuperSecretPassword123',
        duration_ms: 100,
        success: true,
      });

      const raw = lines.join('');
      // The password should never appear in plaintext when hash_commands is true
      expect(raw).not.toContain('SuperSecretPassword123');
      // But the hash should be present
      const record = JSON.parse(lines[0]) as AuditRecord;
      expect(record.command_hash).toBe(sha256('echo SuperSecretPassword123'));
    });

    it('hashes commands by default', () => {
      const records: AuditRecord[] = [];
      const logger = new AuditLogger({
        stdout: true,
        stdoutWriter: (line) => records.push(JSON.parse(line)),
      });

      logger.log({
        tool: 'ssh_execute',
        host: 'h1',
        username: 'u1',
        command: 'cat /etc/shadow',
        duration_ms: 10,
        success: true,
      });

      expect(records[0].command_hash).toBe(sha256('cat /etc/shadow'));
      expect(records[0].command_hash).not.toBe('cat /etc/shadow');
    });

    it('logs plaintext when hashCommands=false', () => {
      const records: AuditRecord[] = [];
      const logger = new AuditLogger({
        stdout: true,
        hashCommands: false,
        stdoutWriter: (line) => records.push(JSON.parse(line)),
      });

      logger.log({
        tool: 'ssh_execute',
        host: 'h1',
        username: 'u1',
        command: 'ls -la',
        duration_ms: 10,
        success: true,
      });

      expect(records[0].command_hash).toBe('ls -la');
    });

    it('record schema has no password, credential, or secret field', () => {
      const records: AuditRecord[] = [];
      const logger = new AuditLogger({
        stdout: true,
        stdoutWriter: (line) => records.push(JSON.parse(line)),
      });

      logger.log({
        tool: 'ssh_execute',
        host: 'h1',
        username: 'u1',
        duration_ms: 10,
        success: true,
      });

      const keys = Object.keys(records[0]);
      for (const key of keys) {
        expect(key.toLowerCase()).not.toContain('password');
        expect(key.toLowerCase()).not.toContain('secret');
        expect(key.toLowerCase()).not.toContain('credential_ref');
      }
    });
  });

  // ── File destination ───────────────────────────────────────────────────
  describe('file destination', () => {
    let tmpFile: string;

    beforeEach(() => {
      tmpFile = join(tmpdir(), `audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    });

    afterEach(() => {
      if (existsSync(tmpFile)) {
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    });

    it('appends JSON-lines to file', () => {
      const writtenData: string[] = [];
      const logger = new AuditLogger({
        filePath: tmpFile,
        fileWriter: (_path, data) => writtenData.push(data),
      });

      logger.log({
        tool: 'ssh_execute',
        host: 'h1',
        username: 'u1',
        command: 'ls',
        duration_ms: 10,
        success: true,
      });

      logger.log({
        tool: 'ssh_session_open',
        host: 'h2',
        username: 'u2',
        duration_ms: 20,
        success: false,
      });

      expect(writtenData).toHaveLength(2);
      // Each should be a valid JSON line
      for (const line of writtenData) {
        expect(line.endsWith('\n')).toBe(true);
        const parsed = JSON.parse(line.trim());
        expect(parsed.tool).toBeTruthy();
      }
    });

    it('readLastRecords returns records from file', () => {
      const logger = new AuditLogger({ filePath: tmpFile });

      // Write some records to the file
      const records = [];
      for (let i = 0; i < 5; i++) {
        records.push(JSON.stringify({
          timestamp: new Date().toISOString(),
          tool: `tool_${i}`,
          host: 'h1',
          username: 'u1',
          credential_backend: null,
          command_hash: null,
          exit_code: 0,
          duration_ms: i * 10,
          stdout_bytes: null,
          stderr_bytes: null,
          success: true,
        }));
      }
      writeFileSync(tmpFile, records.join('\n') + '\n', 'utf-8');

      const result = logger.readLastRecords(3);
      expect(result).toHaveLength(3);
      expect(result[0].tool).toBe('tool_2');
      expect(result[2].tool).toBe('tool_4');
    });

    it('readLastRecords returns empty array when no file', () => {
      const logger = new AuditLogger({ filePath: '/tmp/nonexistent-audit.jsonl' });
      expect(logger.readLastRecords()).toEqual([]);
    });
  });

  // ── Multiple destinations ──────────────────────────────────────────────
  describe('multiple destinations', () => {
    it('emits to file, stdout, and syslog simultaneously', () => {
      const fileWrites: string[] = [];
      const stdoutWrites: string[] = [];
      const syslogWrites: string[] = [];

      const logger = new AuditLogger({
        filePath: '/tmp/test-audit.jsonl',
        stdout: true,
        syslog: true,
        fileWriter: (_path, data) => fileWrites.push(data),
        stdoutWriter: (line) => stdoutWrites.push(line),
        syslogSender: (msg) => syslogWrites.push(msg),
      });

      logger.log({
        tool: 'ssh_execute',
        host: 'h1',
        username: 'u1',
        duration_ms: 10,
        success: true,
      });

      expect(fileWrites).toHaveLength(1);
      expect(stdoutWrites).toHaveLength(1);
      expect(syslogWrites).toHaveLength(1);

      // All should contain the same record
      const fileRecord = JSON.parse(fileWrites[0]);
      const stdoutRecord = JSON.parse(stdoutWrites[0]);
      const syslogRecord = JSON.parse(syslogWrites[0]);
      expect(fileRecord.tool).toBe('ssh_execute');
      expect(stdoutRecord.tool).toBe('ssh_execute');
      expect(syslogRecord.tool).toBe('ssh_execute');
    });
  });

  // ── enabled flag ───────────────────────────────────────────────────────
  describe('enabled', () => {
    it('returns false when no destinations configured', () => {
      const logger = new AuditLogger({});
      expect(logger.enabled).toBe(false);
    });

    it('returns true when file configured', () => {
      const logger = new AuditLogger({ filePath: '/tmp/audit.jsonl' });
      expect(logger.enabled).toBe(true);
    });

    it('returns true when stdout configured', () => {
      const logger = new AuditLogger({ stdout: true });
      expect(logger.enabled).toBe(true);
    });

    it('returns true when syslog configured', () => {
      const logger = new AuditLogger({ syslog: true });
      expect(logger.enabled).toBe(true);
    });

    it('does not emit when disabled', () => {
      const stdoutWrites: string[] = [];
      const logger = new AuditLogger({
        stdoutWriter: (line) => stdoutWrites.push(line),
      });

      logger.log({
        tool: 'ssh_execute',
        host: 'h1',
        username: 'u1',
        duration_ms: 10,
        success: true,
      });

      expect(stdoutWrites).toHaveLength(0);
    });
  });

  // ── Error resilience ───────────────────────────────────────────────────
  describe('error resilience', () => {
    it('continues to other destinations when one fails', () => {
      const stderrWrites: string[] = [];
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(
        (chunk: string | Uint8Array) => {
          stderrWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
          return true;
        }
      );

      const stdoutWrites: string[] = [];

      const logger = new AuditLogger({
        filePath: '/tmp/audit.jsonl',
        stdout: true,
        fileWriter: () => { throw new Error('disk full'); },
        stdoutWriter: (line) => stdoutWrites.push(line),
      });

      logger.log({
        tool: 'ssh_execute',
        host: 'h1',
        username: 'u1',
        duration_ms: 10,
        success: true,
      });

      // File write failed but stdout still received the record
      expect(stdoutWrites).toHaveLength(1);
      expect(stderrWrites.some((w) => w.includes('file write error'))).toBe(true);

      stderrSpy.mockRestore();
    });
  });

  // ── Failure audit records ──────────────────────────────────────────────
  describe('failure records', () => {
    it('emits record with success=false', () => {
      const records: AuditRecord[] = [];
      const logger = new AuditLogger({
        stdout: true,
        stdoutWriter: (line) => records.push(JSON.parse(line)),
      });

      logger.log({
        tool: 'ssh_execute',
        host: 'bad-host',
        username: 'user',
        command: 'whoami',
        duration_ms: 5000,
        success: false,
      });

      expect(records).toHaveLength(1);
      expect(records[0].success).toBe(false);
      expect(records[0].host).toBe('bad-host');
    });
  });
});
