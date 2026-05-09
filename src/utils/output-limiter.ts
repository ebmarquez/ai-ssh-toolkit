/**
 * Output size limiter — caps SSH command output to protect the agent context
 * window.  When output exceeds the configured byte limit (or `output_to_file`
 * is set), the full output is written to disk and an inline head/tail preview
 * is returned instead.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

/** Default cap: 64 KB */
export const DEFAULT_MAX_OUTPUT_BYTES = 65_536;

/** Max bytes for each inline preview segment (head / tail). */
const MAX_PREVIEW_BYTES = 8_192;

const HEAD_LINES = 50;
const TAIL_LINES = 20;

export interface OutputLimitOptions {
  max_output_bytes?: number;
  output_to_file?: string;
}

export interface OutputLimitResult {
  /** Inline output — full text when under limit, or head+tail preview when truncated. */
  output: string;
  truncated?: boolean;
  total_bytes?: number;
  head?: string;
  tail?: string;
  saved_path?: string;
}

/**
 * Returns the base directory for overflow files.
 * Uses `os.tmpdir()` for portability; override via `AI_SSH_TOOLKIT_OUTPUT_DIR`.
 */
function getOutputDir(): string {
  return process.env.AI_SSH_TOOLKIT_OUTPUT_DIR ?? join(tmpdir(), 'ai-ssh-toolkit');
}

/**
 * Slice a string so its UTF-8 byte length does not exceed `maxBytes`.
 * Avoids splitting multi-byte characters.
 */
function byteSafeSlice(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf-8');
  if (buf.length <= maxBytes) return str;
  // Walk back from maxBytes to avoid splitting a multi-byte char
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf-8');
}

/**
 * Build an inline preview (head + tail) of `output`, byte-capped.
 */
function buildPreview(output: string): { head: string; tail: string } {
  const lines = output.split('\n');
  const headLines = lines.slice(0, HEAD_LINES).join('\n');
  const tailLines = lines.slice(-TAIL_LINES).join('\n');
  return {
    head: byteSafeSlice(headLines, MAX_PREVIEW_BYTES),
    tail: byteSafeSlice(tailLines, MAX_PREVIEW_BYTES),
  };
}

/**
 * Write `content` to a file. Creates parent directory with 0o700.
 * Generated overflow files use `wx` flag to never overwrite.
 */
async function writeOutputFile(
  filePath: string,
  content: string,
  isGenerated: boolean,
): Promise<void> {
  const dir = join(filePath, '..');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(filePath, content, {
    encoding: 'utf-8',
    mode: 0o600,
    flag: isGenerated ? 'wx' : 'w',
  });
}

/**
 * Apply output limiting.
 *
 * - If `output_to_file` is set, always write full output there and return
 *   head/tail inline.
 * - If output exceeds `max_output_bytes`, write to a generated overflow file
 *   and return head/tail inline.
 * - Otherwise return the full output unchanged.
 */
export async function applyOutputLimit(
  output: string,
  options: OutputLimitOptions = {},
): Promise<OutputLimitResult> {
  const maxBytes = options.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const totalBytes = Buffer.byteLength(output, 'utf-8');
  const outputToFile = options.output_to_file;

  // Case 1: caller explicitly requested output_to_file
  if (outputToFile) {
    await writeOutputFile(outputToFile, output, false);
    const { head, tail } = buildPreview(output);
    return {
      output: `[Full output saved to ${outputToFile}]\n\n--- head (first ${HEAD_LINES} lines) ---\n${head}\n\n--- tail (last ${TAIL_LINES} lines) ---\n${tail}`,
      truncated: totalBytes > maxBytes,
      total_bytes: totalBytes,
      head,
      tail,
      saved_path: outputToFile,
    };
  }

  // Case 2: output is within the byte limit — return unchanged
  if (totalBytes <= maxBytes) {
    return { output };
  }

  // Case 3: output exceeds byte limit — overflow to generated file
  const outputDir = getOutputDir();
  const savedPath = join(outputDir, `${randomUUID()}.txt`);
  await writeOutputFile(savedPath, output, true);

  const { head, tail } = buildPreview(output);
  return {
    output: `[Output truncated: ${totalBytes} bytes exceeds ${maxBytes} byte limit. Full output saved to ${savedPath}]\n\n--- head (first ${HEAD_LINES} lines) ---\n${head}\n\n--- tail (last ${TAIL_LINES} lines) ---\n${tail}`,
    truncated: true,
    total_bytes: totalBytes,
    head,
    tail,
    saved_path: savedPath,
  };
}
