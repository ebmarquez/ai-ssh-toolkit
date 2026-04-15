import { describe, it, expect } from "vitest";
import { scrubOutput } from "../../src/ssh/output-scrubber.js";

describe("scrubOutput", () => {
  it("removes password prompt lines", () => {
    const input = "Password: secretpass\nswitch01# show version";
    const result = scrubOutput(input);
    expect(result).not.toContain("Password:");
    expect(result).toContain("show version");
  });

  it("removes ANSI escape sequences", () => {
    const input = "\x1B[32mswitch01#\x1B[0m show version";
    const result = scrubOutput(input);
    expect(result).not.toContain("\x1B[");
    expect(result).toContain("switch01#");
  });

  it("preserves normal command output", () => {
    const input = "Cisco Nexus Operating System\nVersion 10.3(4a)";
    expect(scrubOutput(input)).toBe(input);
  });

  it("handles empty input", () => {
    expect(scrubOutput("")).toBe("");
  });

  it("handles multiple password prompts", () => {
    const input = "Password: first\nPassword: second\nswitch01# ";
    const result = scrubOutput(input);
    expect(result).not.toContain("Password:");
  });
});
