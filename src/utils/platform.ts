import { platform } from "os";

export type SupportedPlatform = "win32" | "linux" | "darwin";

export function currentPlatform(): SupportedPlatform {
  const p = platform();
  if (p === "win32" || p === "linux" || p === "darwin") return p;
  throw new Error(`Unsupported platform: ${p}`);
}

export function defaultSshPath(): string {
  return currentPlatform() === "win32"
    ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe"
    : "/usr/bin/ssh";
}
