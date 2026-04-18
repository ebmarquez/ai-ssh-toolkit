import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { currentPlatform } from "./platform.js";

/**
 * Resolve a CLI tool name to its absolute path.
 * Rejects if the resolved path does not exist on disk.
 */
export function resolveCliPath(toolName: string): string {
  const isWin = currentPlatform() === "win32";
  const cmd = isWin ? "where.exe" : "which";

  let resolved: string;
  try {
    resolved = execFileSync(cmd, [toolName], {
      encoding: "utf-8",
      timeout: 5000,
    })
      .trim()
      .split("\n")[0]
      .trim();
  } catch {
    throw new Error(`CLI tool not found: ${toolName}`);
  }

  if (!existsSync(resolved)) {
    throw new Error(`Resolved CLI path does not exist: ${resolved}`);
  }

  return resolved;
}

/**
 * Resolve the absolute path to the `ssh` binary.
 */
export async function resolveSshBin(): Promise<string> {
  return resolveCliPath('ssh');
}
