import { describe, it, expect } from "vitest";
import { detectPrompt, detectPasswordPrompt } from "../../src/ssh/prompt-detector.js";

describe("detectPrompt", () => {
  it("detects NX-OS prompt", () => {
    expect(detectPrompt("switch01# ", "nxos")).toBe(true);
  });

  it("detects NX-OS config prompt", () => {
    expect(detectPrompt("switch01(config)# ", "nxos")).toBe(true);
  });

  it("detects Dell OS10 prompt", () => {
    expect(detectPrompt("leaf-01# ", "os10")).toBe(true);
  });

  it("detects Dell OS10 config prompt", () => {
    expect(detectPrompt("leaf-01(conf)# ", "os10")).toBe(true);
  });

  it("detects SONiC prompt", () => {
    expect(detectPrompt("admin@sonic:~$ ", "sonic")).toBe(true);
  });

  it("detects Linux prompt with $", () => {
    expect(detectPrompt("user@host:~$ ", "linux")).toBe(true);
  });

  it("detects Linux root prompt with #", () => {
    expect(detectPrompt("root@host:~# ", "linux")).toBe(true);
  });

  it("auto mode matches NX-OS", () => {
    expect(detectPrompt("switch01# ", "auto")).toBe(true);
  });

  it("auto mode matches SONiC", () => {
    expect(detectPrompt("admin@sonic:~$ ", "auto")).toBe(true);
  });

  it("returns false for non-prompt text", () => {
    expect(detectPrompt("show version output here", "auto")).toBe(false);
  });

  it("returns false for partial prompt", () => {
    expect(detectPrompt("Loading configuration...", "nxos")).toBe(false);
  });
});

describe("detectPasswordPrompt", () => {
  it("detects Password: prompt", () => {
    expect(detectPasswordPrompt("Password: ")).toBe(true);
  });

  it("detects password: prompt (lowercase)", () => {
    expect(detectPasswordPrompt("password: ")).toBe(true);
  });

  it("returns false for non-password text", () => {
    expect(detectPasswordPrompt("switch01# ")).toBe(false);
  });
});
