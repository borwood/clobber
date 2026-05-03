import { describe, it, expect } from "bun:test";
import { loadRoleBundle, managerRole } from "../src/index.ts";

describe("loadRoleBundle", () => {
  it("returns the manager bundle by name", () => {
    expect(loadRoleBundle("manager")).toBe(managerRole);
  });

  it("returns null for an unknown role name", () => {
    expect(loadRoleBundle("nonexistent-role")).toBeNull();
  });
});
