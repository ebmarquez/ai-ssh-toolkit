/**
 * Structured audit logger for SSH operations.
 *
 * Emits JSON audit records to configurable destinations (file, syslog, stdout).
 * NEVER logs credentials, passwords, or command plaintext by default.
 *
 * Environment variables:
 *  - AI_SSH_AUDIT_LOG=<filepath>  → JSON-lines file output (append)
 *  - AI_SSH_AUDIT_SYSLOG=1       → write to syslog (posix dgram socket)
 *  - AI_SSH_AUDIT_STDOUT=1       → write to stdout
 *  - AI_SSH_AUDIT_HASH_COMMANDS=false → log command plaintext instead of hash
 */

import { createHash } from 'crypto';
import { appendFileSync, readFileSync, existsSync } from 'fs';
import * as dgram from 'dgram';

export interface AuditRecord {
  timestamp: string;          // ISO 8601
  tool: string;
  host: string;
  username: string;
  credential_backend: string | null;
  command_hash: string | null; // SHA-256 hex or plaintext depending on config
  exit_code: number | null;
  duration_ms: number;
  stdout_bytes: number | null;
  stderr_bytes: number | null;
  success: boolean;
}

export interface AuditLoggerOptions {
  /** Path to JSON-lines audit log file. Overrides AI_SSH_AUDIT_LOG env var. */
  filePath?: string;
  /** Enable syslog output. Overrides AI_SSH_AUDIT_SYSLOG env var. */
  syslog?: boolean;
  /** Enable stdout output. Overrides AI_SSH_AUDIT_STDOUT env var. */
  stdout?: boolean;
  /** When true, hash commands with SHA-256 (default: true). */
  hashCommands?: boolean;
  /** Override for process.stdout.write (testing). */
  stdoutWriter?: (line: string) => void;
  /** Override for file append (testing). */
  fileWriter?: (path: string, data: string) => void;
  /** Override for syslog sender (testing). */
  syslogSender?: (message: string) => void;
}

/**
 * Compute SHA-256 hex digest of a string.
 */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export class AuditLogger {
  private readonly filePath: string | undefined;
  private readonly syslog: boolean;
  private readonly stdout: boolean;
  private readonly hashCommands: boolean;
  private readonly stdoutWriter: (line: string) => void;
  private readonly fileWriter: (path: string, data: string) => void;
  private readonly syslogSender: (message: string) => void;

  constructor(opts: AuditLoggerOptions = {}) {
    this.filePath = opts.filePath ?? process.env.AI_SSH_AUDIT_LOG ?? undefined;
    this.syslog = opts.syslog ?? process.env.AI_SSH_AUDIT_SYSLOG === '1';
    this.stdout = opts.stdout ?? process.env.AI_SSH_AUDIT_STDOUT === '1';

    // Default: hash commands (secure). Set AI_SSH_AUDIT_HASH_COMMANDS=false to log plaintext.
    const hashEnv = process.env.AI_SSH_AUDIT_HASH_COMMANDS;
    this.hashCommands = opts.hashCommands ?? (hashEnv !== 'false');

    this.stdoutWriter = opts.stdoutWriter ?? ((line: string) => process.stdout.write(line));
    this.fileWriter = opts.fileWriter ?? ((path: string, data: string) => appendFileSync(path, data, 'utf-8'));
    this.syslogSender = opts.syslogSender ?? defaultSyslogSender;
  }

  /**
   * Whether any audit destination is configured.
   */
  get enabled(): boolean {
    return !!(this.filePath || this.syslog || this.stdout);
  }

  /**
   * The configured file path, if any.
   */
  get logFilePath(): string | undefined {
    return this.filePath;
  }

  /**
   * Prepare the command field: SHA-256 hash or plaintext.
   */
  formatCommand(command: string | null | undefined): string | null {
    if (command == null || command === '') return null;
    return this.hashCommands ? sha256(command) : command;
  }

  /**
   * Emit an audit record to all configured destinations.
   */
  emit(record: AuditRecord): void {
    if (!this.enabled) return;

    const line = JSON.stringify(record) + '\n';

    if (this.filePath) {
      try {
        this.fileWriter(this.filePath, line);
      } catch (err) {
        process.stderr.write(`[audit] file write error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    if (this.stdout) {
      try {
        this.stdoutWriter(line);
      } catch (err) {
        process.stderr.write(`[audit] stdout write error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    if (this.syslog) {
      try {
        this.syslogSender(line.trimEnd());
      } catch (err) {
        process.stderr.write(`[audit] syslog error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  /**
   * Build and emit an audit record with timing.
   */
  log(params: {
    tool: string;
    host: string;
    username: string;
    credential_backend?: string | null;
    command?: string | null;
    exit_code?: number | null;
    duration_ms: number;
    stdout_bytes?: number | null;
    stderr_bytes?: number | null;
    success: boolean;
  }): void {
    const record: AuditRecord = {
      timestamp: new Date().toISOString(),
      tool: params.tool,
      host: params.host,
      username: params.username,
      credential_backend: params.credential_backend ?? null,
      command_hash: this.formatCommand(params.command),
      exit_code: params.exit_code ?? null,
      duration_ms: params.duration_ms,
      stdout_bytes: params.stdout_bytes ?? null,
      stderr_bytes: params.stderr_bytes ?? null,
      success: params.success,
    };
    this.emit(record);
  }

  /**
   * Read the last N records from the file destination.
   * Returns empty array if file destination is not configured or file doesn't exist.
   */
  readLastRecords(limit: number = 50): AuditRecord[] {
    if (!this.filePath || !existsSync(this.filePath)) return [];

    try {
      const content = readFileSync(this.filePath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      const tail = lines.slice(-limit);
      return tail.map((line) => JSON.parse(line) as AuditRecord);
    } catch {
      return [];
    }
  }
}

/**
 * Default syslog sender using UDP to /dev/log (Linux) or localhost:514.
 * Uses LOG_INFO (priority 14 = facility 1 (user) * 8 + severity 6 (info)).
 */
function defaultSyslogSender(message: string): void {
  const priority = 14; // LOG_USER | LOG_INFO
  const tag = 'ai-ssh-toolkit';
  const syslogMessage = `<${priority}>${tag}: ${message}`;
  const buf = Buffer.from(syslogMessage, 'utf-8');

  // Try Unix domain socket first, fall back to UDP localhost:514
  try {
    const sock = dgram.createSocket('udp4');
    sock.send(buf, 0, buf.length, 514, '127.0.0.1', () => {
      try { sock.close(); } catch { /* ignore */ }
    });
  } catch { /* best-effort */ }
}
