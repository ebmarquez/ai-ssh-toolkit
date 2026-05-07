/**
 * Unit tests for the output-limiter utility.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyOutputLimit, DEFAULT_MAX_OUTPUT_BYTES } from '../../src/utils/output-limiter.js';

const TEST_OUTPUT_DIR = join(tmpdir(), 'ai-ssh-toolkit-test-' + process.pid);

beforeEach(() => {
  process.env.AI_SSH_TOOLKIT_OUTPUT_DIR = TEST_OUTPUT_DIR;
});

afterEach(() => {
  delete process.env.AI_SSH_TOOLKIT_OUTPUT_DIR;
  if (existsSync(TEST_OUTPUT_DIR)) {
    rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
  }
});

describe('applyOutputLimit', () => {
  it('returns output unchanged when under default limit', async () => {
    const output = 'Hello, world!\nLine 2\n';
    const result = await applyOutputLimit(output);

    expect(result.output).toBe(output);
    expect(result.truncated).toBeUndefined();
    expect(result.saved_path).toBeUndefined();
    expect(result.head).toBeUndefined();
    expect(result.tail).toBeUndefined();
  });

  it('returns output unchanged when exactly at limit', async () => {
    // Build a string that is exactly DEFAULT_MAX_OUTPUT_BYTES in UTF-8
    const output = 'A'.repeat(DEFAULT_MAX_OUTPUT_BYTES);
    const result = await applyOutputLimit(output);

    expect(result.output).toBe(output);
    expect(result.truncated).toBeUndefined();
  });

  it('truncates output exceeding the default limit', async () => {
    const lineCount = 200;
    const lines = Array.from({ length: lineCount }, (_, i) => `Line ${i + 1}: ${'x'.repeat(500)}`);
    const output = lines.join('\n');
    expect(Buffer.byteLength(output, 'utf-8')).toBeGreaterThan(DEFAULT_MAX_OUTPUT_BYTES);

    const result = await applyOutputLimit(output);

    expect(result.truncated).toBe(true);
    expect(result.total_bytes).toBe(Buffer.byteLength(output, 'utf-8'));
    expect(result.head).toBeDefined();
    expect(result.tail).toBeDefined();
    expect(result.saved_path).toBeDefined();
    expect(result.output).toContain('Output truncated');
    expect(result.output).toContain('head');
    expect(result.output).toContain('tail');

    // Verify overflow file was written with full content
    expect(existsSync(result.saved_path!)).toBe(true);
    const savedContent = readFileSync(result.saved_path!, 'utf-8');
    expect(savedContent).toBe(output);
  });

  it('respects custom max_output_bytes', async () => {
    const output = 'A'.repeat(100);
    const result = await applyOutputLimit(output, { max_output_bytes: 50 });

    expect(result.truncated).toBe(true);
    expect(result.total_bytes).toBe(100);
    expect(result.saved_path).toBeDefined();
    expect(existsSync(result.saved_path!)).toBe(true);
  });

  it('head contains first 50 lines', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    const output = lines.join('\n');

    const result = await applyOutputLimit(output, { max_output_bytes: 10 });

    expect(result.head).toBeDefined();
    expect(result.head!).toContain('Line 1');
    expect(result.head!).toContain('Line 50');
    expect(result.head!).not.toContain('Line 51');
  });

  it('tail contains last 20 lines', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    const output = lines.join('\n');

    const result = await applyOutputLimit(output, { max_output_bytes: 10 });

    expect(result.tail).toBeDefined();
    expect(result.tail!).toContain('Line 81');
    expect(result.tail!).toContain('Line 100');
  });

  it('handles empty output without truncation', async () => {
    const result = await applyOutputLimit('');

    expect(result.output).toBe('');
    expect(result.truncated).toBeUndefined();
  });

  describe('output_to_file', () => {
    it('writes full output to specified file and returns head/tail', async () => {
      const filePath = join(TEST_OUTPUT_DIR, 'explicit-output.txt');
      const output = 'Small output for file';

      const result = await applyOutputLimit(output, { output_to_file: filePath });

      expect(result.saved_path).toBe(filePath);
      expect(result.head).toBeDefined();
      expect(result.tail).toBeDefined();
      expect(result.output).toContain('Full output saved to');
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, 'utf-8')).toBe(output);
    });

    it('sets truncated=false when output_to_file is used with small output', async () => {
      const filePath = join(TEST_OUTPUT_DIR, 'small.txt');
      const output = 'tiny';

      const result = await applyOutputLimit(output, { output_to_file: filePath });

      expect(result.truncated).toBe(false);
      expect(result.total_bytes).toBe(4);
    });

    it('sets truncated=true when output_to_file is used with large output', async () => {
      const filePath = join(TEST_OUTPUT_DIR, 'large.txt');
      const output = 'A'.repeat(DEFAULT_MAX_OUTPUT_BYTES + 1);

      const result = await applyOutputLimit(output, { output_to_file: filePath });

      expect(result.truncated).toBe(true);
      expect(result.saved_path).toBe(filePath);
    });
  });

  describe('byte-safe preview', () => {
    it('caps head preview to avoid very long single-line output', async () => {
      // Single very long line — head should be byte-capped
      const output = 'X'.repeat(100_000);

      const result = await applyOutputLimit(output, { max_output_bytes: 10 });

      expect(result.head).toBeDefined();
      expect(Buffer.byteLength(result.head!, 'utf-8')).toBeLessThanOrEqual(8192);
    });

    it('handles multibyte UTF-8 characters without splitting', async () => {
      // Each emoji is 4 bytes in UTF-8
      const emoji = '😀';
      const output = emoji.repeat(30_000); // ~120KB — over default limit

      const result = await applyOutputLimit(output);

      expect(result.truncated).toBe(true);
      expect(result.head).toBeDefined();
      // Head should be valid UTF-8 — no replacement chars
      expect(result.head!).not.toContain('\uFFFD');
      // Full output saved correctly
      const saved = readFileSync(result.saved_path!, 'utf-8');
      expect(saved).toBe(output);
    });
  });
});
