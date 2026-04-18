import { describe, it, expect } from "vitest";
import { scrubOutput } from "../../src/ssh/output-scrubber.js";

describe("scrubOutput", () => {
  it("removes password prompt lines", () => {
    const input = "Password: secretpass\nswitch01# show version";
    const result = scrubOutput(input);
    expect(result).not.toContain("Password:");
    expect(result).toContain("show version");
  });

  it("removes secret/passphrase/token style prompt lines", () => {
    const input = "Secret: topsecret\nEnter passphrase: abc123\nAuthentication token: 999999\nToken: 123456\nswitch01# show run";
    const result = scrubOutput(input);
    expect(result).not.toContain("Secret:");
    expect(result).not.toContain("passphrase");
    expect(result).not.toContain("Authentication token:");
    expect(result).not.toContain("Token: 123456");
    expect(result).toContain("show run");
  });

  it("removes ANSI escape sequences", () => {
    const input = "\x1B[32mswitch01#\x1B[0m show version";
    const result = scrubOutput(input);
    expect(result).not.toContain("\x1B[");
    expect(result).toContain("switch01#");
  });

  it("removes OSC and DCS escape sequences", () => {
    const input = "hello\x1B]0;window title\x07world\x1BP1$r0m\x1B\\done";
    const result = scrubOutput(input);
    expect(result).toBe("helloworlddone");
  });

  it("preserves normal command output", () => {
    const input = "Cisco Nexus Operating System\nVersion 10.3(4a)";
    expect(scrubOutput(input)).toBe(input);
  });

  it("does not strip normal output containing token/secret words mid-line", () => {
    const input = "Token Ring: enabled\nsecret sauce recipe: unavailable\nshow version";
    const result = scrubOutput(input);
    expect(result).toContain("Token Ring: enabled");
    expect(result).toContain("secret sauce recipe: unavailable");
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
