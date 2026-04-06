import { describe, it, expect } from "vitest";
import { validateCwd } from "../src/adapters/claude-code";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

const HOME = homedir();

describe("validateCwd", () => {
  it("allows paths under ~/Workspace", () => {
    expect(validateCwd(resolve(HOME, "Workspace/my-project"))).toBe(true);
  });

  it("allows the Workspace directory itself", () => {
    expect(validateCwd(resolve(HOME, "Workspace"))).toBe(true);
  });

  it("allows the home directory itself", () => {
    expect(validateCwd(HOME)).toBe(true);
  });

  it("rejects paths outside allowed directories", () => {
    expect(validateCwd("/tmp/evil")).toBe(false);
    expect(validateCwd("/etc/passwd")).toBe(false);
  });

  it("blocks ~/.ssh", () => {
    expect(validateCwd(resolve(HOME, ".ssh"))).toBe(false);
    expect(validateCwd(resolve(HOME, ".ssh/keys"))).toBe(false);
  });

  it("blocks ~/.aws", () => {
    expect(validateCwd(resolve(HOME, ".aws"))).toBe(false);
    expect(validateCwd(resolve(HOME, ".aws/credentials"))).toBe(false);
  });

  it("blocks ~/.claude", () => {
    expect(validateCwd(resolve(HOME, ".claude"))).toBe(false);
  });

  it("blocks ~/.gnupg", () => {
    expect(validateCwd(resolve(HOME, ".gnupg"))).toBe(false);
  });

  it("blocks ~/.config/gh", () => {
    expect(validateCwd(resolve(HOME, ".config/gh"))).toBe(false);
  });

  it("normalizes paths with .. traversal", () => {
    // ~/Workspace/../.ssh should be blocked
    expect(validateCwd(resolve(HOME, "Workspace/../.ssh"))).toBe(false);
  });

  it("expands ~ prefix and blocks ~/.ssh", () => {
    expect(validateCwd("~/.ssh")).toBe(false);
    expect(validateCwd("~/.ssh/keys")).toBe(false);
  });

  it("expands ~ prefix and blocks ~/.aws", () => {
    expect(validateCwd("~/.aws")).toBe(false);
  });

  it("expands ~ prefix and allows ~/Workspace", () => {
    expect(validateCwd("~/Workspace")).toBe(true);
    expect(validateCwd("~/Workspace/my-project")).toBe(true);
  });

  it("expands bare ~ to home directory", () => {
    expect(validateCwd("~")).toBe(true);
  });

  it("allows custom allowedPaths", () => {
    // Use platform-aware absolute paths so the test works on both Unix and Windows
    const base = resolve(HOME, "custom-projects");
    const sub = resolve(base, "foo");
    const outside = resolve(HOME, "other-place");
    expect(validateCwd(sub, [base])).toBe(true);
    expect(validateCwd(outside, [base])).toBe(false);
  });
});
