import { describe, it, expect } from "bun:test";
import { filterRoleAssignments } from "../src/components/role-picker-filter.ts";
import type { WorkspaceRoleAssignment } from "../src/api.ts";

function asg(
  name: string,
  description: string | undefined = undefined,
  max_concurrent = 1,
): WorkspaceRoleAssignment {
  return {
    role: {
      id: name,
      name,
      persistent: false,
      ...(description === undefined ? {} : { description }),
    },
    max_concurrent,
  } as unknown as WorkspaceRoleAssignment;
}

const SAMPLE: readonly WorkspaceRoleAssignment[] = [
  asg("manager", "Triages issues and spawns workers"),
  asg("worker", "General-purpose engineer"),
  asg("auditor"),
  asg("flaky-test-fixer-experimental", "Forked from worker for retry investigation"),
  asg("idle-role-no-ceiling", "should not appear because ceiling is 0", 0),
];

describe("filterRoleAssignments", () => {
  it("returns only spawnable (max_concurrent > 0) when query is empty", () => {
    const result = filterRoleAssignments(SAMPLE, "");
    expect(result.map((a) => a.role.name)).toEqual([
      "manager",
      "worker",
      "auditor",
      "flaky-test-fixer-experimental",
    ]);
  });

  it("matches case-insensitively against role name", () => {
    const result = filterRoleAssignments(SAMPLE, "MANAGER");
    expect(result.map((a) => a.role.name)).toEqual(["manager"]);
  });

  it("matches case-insensitively against description", () => {
    const result = filterRoleAssignments(SAMPLE, "engineer");
    expect(result.map((a) => a.role.name)).toEqual(["worker"]);
  });

  it("matches a substring spanning name fragments", () => {
    const result = filterRoleAssignments(SAMPLE, "flaky");
    expect(result.map((a) => a.role.name)).toEqual([
      "flaky-test-fixer-experimental",
    ]);
  });

  it("ignores leading/trailing whitespace in the query", () => {
    // "worker" matches "worker" (name), "manager" (description: "spawns workers"),
    // and "flaky-test-fixer-experimental" (description: "Forked from worker…").
    const result = filterRoleAssignments(SAMPLE, "  worker  ");
    expect(result.map((a) => a.role.name)).toEqual([
      "manager",
      "worker",
      "flaky-test-fixer-experimental",
    ]);
  });

  it("returns empty when no role matches", () => {
    const result = filterRoleAssignments(SAMPLE, "nonexistent");
    expect(result).toEqual([]);
  });

  it("never returns roles with max_concurrent = 0, even on direct name match", () => {
    const result = filterRoleAssignments(SAMPLE, "idle-role");
    expect(result).toEqual([]);
  });
});
