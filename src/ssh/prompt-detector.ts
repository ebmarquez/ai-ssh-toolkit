export type PlatformHint = "nxos" | "os10" | "sonic" | "linux" | "auto";

const PROMPT_PATTERNS: Record<string, RegExp[]> = {
  nxos: [/[\w\-]+#\s*$/, /[\w\-]+\([\w\-]+\)#\s*$/],
  os10: [/[\w\-]+#\s*$/, /[\w\-]+\([\w\-]+\)#\s*$/],
  sonic: [/[\w]+@[\w\-]+:~\$\s*$/],
  linux: [/[\w]+@[\w\-]+:.*[\$#]\s*$/, /[#\$]\s*$/],
};

export function detectPrompt(output: string, hint: PlatformHint): boolean {
  const patterns =
    hint === "auto"
      ? Object.values(PROMPT_PATTERNS).flat()
      : PROMPT_PATTERNS[hint] ?? Object.values(PROMPT_PATTERNS).flat();

  return patterns.some((p) => p.test(output));
}

export function detectPasswordPrompt(output: string): boolean {
  return /[Pp]assword:\s*$/.test(output);
}
