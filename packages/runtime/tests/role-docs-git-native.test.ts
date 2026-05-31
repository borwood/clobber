import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #216 PR3 — a cheap regression against doc drift: the manager:roles SKILL and
// the agent-model "Locked decisions" once described the dead DB-version model
// (edit = insert a new role_versions row + bump a pointer; fork = copy the
// current version). Roles are now git branches: edit = checkout → commit
// advancing the branch; fork = checkout -b. These assertions fail loudly if the
// stale phrasings ever creep back.

const SKILL_MD = join(
  import.meta.dir,
  "..",
  "roles",
  "manager",
  "plugin-template",
  "skills",
  "roles",
  "SKILL.md",
);
const AGENT_MODEL_MD = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "architecture",
  "agent-model.md",
);

describe("#216 role docs describe the git-native working-copy model", () => {
  it("manager:roles SKILL.md drops the dead versioning prose for checkout → commit", () => {
    const skill = readFileSync(SKILL_MD, "utf8");
    expect(skill).not.toContain("Versioning rule");
    expect(skill).not.toContain("bump the role to a new version");
    expect(skill).not.toContain("versioned edit path");
    // The git-native model is present.
    expect(skill).toContain("checkout -b");
    expect(skill).toContain("roles commit");
    expect(skill).toMatch(/working copy/i);
  });

  it("agent-model.md Locked decisions drop the dead row-version phrasings", () => {
    const doc = readFileSync(AGENT_MODEL_MD, "utf8");
    expect(doc).not.toContain("insert new version + bump pointer");
    expect(doc).not.toContain("copies the current version into a new role");
    // The git-native model is present, pointing at the substrate work.
    expect(doc).toContain("Roles are git branches");
    expect(doc).toContain("#216");
  });
});
