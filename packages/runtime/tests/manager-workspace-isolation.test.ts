import { describe, it, expect } from "bun:test";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

// Acceptance bar for #148: the engine's default manager bundle must not
// reference workspace-specific names. Workspaces compose their own skills
// (e.g. `/clobber-pm`, runhuman-flavored runbooks) via the skill catalog
// at `<repo>/.clobber/skills/`, gated by `manager_skill_policy`.
//
// Tokens are concatenated so the test file itself doesn't appear in the
// grep results. Add new workspace-specific names here as they come up.
const forbiddenTokens = [
  "clobber" + "-pm",
  "run" + "human",
];

describe("manager bundle workspace isolation (#148)", () => {
  it("default manager role bundle contains none of the workspace-specific tokens", () => {
    const pattern = forbiddenTokens.join("\\|");
    const target = "packages/runtime/roles/manager/";
    let stdout = "";
    try {
      stdout = execSync(`grep -rln '${pattern}' ${target}`, {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
    } catch (e) {
      const err = e as { status?: number };
      if (err.status === 1) return;
      throw e;
    }
    const matches = stdout.trim().split("\n").filter(Boolean);
    expect(matches).toEqual([]);
  });
});
