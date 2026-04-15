import { describe, it, expect } from "vitest";
import { currentPlatform, defaultSshPath } from "../../src/utils/platform.js";

describe("currentPlatform", () => {
  it("returns a supported platform string", () => {
    const result = currentPlatform();
    expect(["win32", "linux", "darwin"]).toContain(result);
  });
});

describe("defaultSshPath", () => {
  it("returns a platform-appropriate SSH path", () => {
    const sshPath = defaultSshPath();
    const plat = currentPlatform();
    if (plat === "win32") {
      expect(sshPath).toContain("ssh.exe");
    } else {
      expect(sshPath).toBe("/usr/bin/ssh");
    }
  });
});
