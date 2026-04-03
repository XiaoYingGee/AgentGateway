import { describe, it, expect } from "vitest";
import { isAllowedUser } from "../src/auth";

describe("isAllowedUser", () => {
  it("returns true for a user in the whitelist", () => {
    expect(isAllowedUser("123", "123,456,789")).toBe(true);
  });

  it("returns true for a user at the end of the list", () => {
    expect(isAllowedUser("789", "123,456,789")).toBe(true);
  });

  it("returns false for a user not in the whitelist", () => {
    expect(isAllowedUser("999", "123,456,789")).toBe(false);
  });

  it("returns false for empty userId", () => {
    expect(isAllowedUser("", "123,456")).toBe(false);
  });

  it("returns false for empty allowedUsers", () => {
    expect(isAllowedUser("123", "")).toBe(false);
  });

  it("handles whitespace in the allowedUsers string", () => {
    expect(isAllowedUser("456", " 123 , 456 , 789 ")).toBe(true);
  });

  it("handles single-user whitelist", () => {
    expect(isAllowedUser("123", "123")).toBe(true);
    expect(isAllowedUser("456", "123")).toBe(false);
  });
});
