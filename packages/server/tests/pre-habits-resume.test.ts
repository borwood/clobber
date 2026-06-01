import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { materializeBundle } from "@clobber/runtime";
import { serializeRoleTree, deserializeRoleTree, type RoleTree } from "../src/role-tree.ts";
import { bundleFromContract } from "../src/role-repo.ts";

// #427 — regression: a commit-pinned role tree from BEFORE #408 (no habits/ files)
// must flow through bundleFromContract → materializeBundle → compileSelfHabits without
// throwing and with habits resolving to []. The ?/?? guards an out-of-band band-aid
// added were unnecessary; this test proves the original code is already correct.

const HOOKS_BASELINE = JSON.stringify({
  hooks: {
    SessionStart: [{ hooks: [{ type: "http", url: "__CLOBBER_HOOK_URL__", async: false }] }],
  },
});

// A RoleTree with NO habits/ entries — the exact shape of every role committed before #408.
function preHabitsTree(): RoleTree {
  return serializeRoleTree({
    framing: "you are the manager",
    systemPrompt: "manage the workspace",
    skills: [{ name: "whoami", body: "# whoami\nRun `clobber whoami`." }],
    allowedTools: ["Bash"],
    allowedCliCommands: ["status"],
    hooks: HOOKS_BASELINE,
    triggers: [],
    seedRefs: [],
    wakePrograms: [],
    defaultWakeProgram: null,
    habits: [],
  });
}

describe("pre-habits resume regression (#427)", () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), "clobber-427-"));
  });
  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it("deserializeRoleTree on a tree with no habits/ entries yields habits: []", () => {
    const tree = preHabitsTree();
    // Confirm no habits/ entries exist — the fixture really is pre-habits.
    for (const key of tree.keys()) {
      expect(key.startsWith("habits/")).toBe(false);
    }
    const contract = deserializeRoleTree(tree);
    expect(contract.habits).toEqual([]);
  });

  it("bundleFromContract propagates habits: [] without throwing", () => {
    const contract = deserializeRoleTree(preHabitsTree());
    const bundle = bundleFromContract(contract, { pluginName: "manager", description: "Workspace manager." });
    expect(bundle.habits).toEqual([]);
  });

  it("materializeBundle on a pre-habits bundle writes hooks.json byte-equal to the URL-substituted baseline", () => {
    const contract = deserializeRoleTree(preHabitsTree());
    const bundle = bundleFromContract(contract, { pluginName: "manager" });
    const hookUrl = "http://127.0.0.1:3300/hook";

    const result = materializeBundle({
      bundle,
      repoPath,
      hookUrl,
      cliEntry: "/abs/cli/index.ts",
      inSessionHabits: true,
    });

    const written = readFileSync(join(result.pluginDir, "hooks", "hooks.json"), "utf8");
    const expected = HOOKS_BASELINE.split("__CLOBBER_HOOK_URL__").join(hookUrl);
    expect(written).toBe(expected);
  });
});
