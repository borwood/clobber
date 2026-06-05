import { describe, it, expect } from "bun:test";
import { enumerateShippedRoles } from "@clobber/runtime";
import { triggerId, type RoleTrigger } from "@clobber/shared";
import { snapshotShippedBundle } from "../src/role-version-snapshot.ts";
import { serializeRoleTree, deserializeRoleTree, type RoleTree, type RoleTreeContract } from "../src/role-tree.ts";
import { roleSnapshotToContract, roleContractToSnapshot } from "../src/role-tree-snapshot.ts";

// #348 is the INVERSE of `snapshotShippedBundle`: the shipped role file tree is
// flattened into JSON-string columns; here we decompose those columns back into
// a merge-friendly file tree and prove the round-trip is lossless. We anchor on
// the real shipped manager + worker roles (integration over unit).

function shippedContracts(): Array<{ name: string; contract: RoleTreeContract; snapshot: ReturnType<typeof snapshotShippedBundle> }> {
  return enumerateShippedRoles().map((loaded) => {
    const allowedTools = loaded.manifest.allowedTools ?? [];
    const snapshot = snapshotShippedBundle({ loaded, allowedTools });
    return { name: loaded.manifest.name, contract: roleSnapshotToContract(snapshot), snapshot };
  });
}

describe("role ↔ git-tree round-trip", () => {
  it("round-trips every shipped role: contract → tree → contract", () => {
    for (const { name, contract } of shippedContracts()) {
      const tree = serializeRoleTree(contract);
      const back = deserializeRoleTree(tree);
      expect(back, `contract round-trip for ${name}`).toEqual(contract);
    }
  });

  it("round-trips all the way back to the snapshot JSON columns", () => {
    for (const { name, contract, snapshot } of shippedContracts()) {
      const tree = serializeRoleTree(contract);
      const back = deserializeRoleTree(tree);
      expect(roleContractToSnapshot(back), `snapshot round-trip for ${name}`).toEqual(snapshot);
    }
  });

  it("decomposes the prompt into independent layer files (framing vs system-prompt)", () => {
    const { contract } = shippedContracts().find((c) => c.name === "worker")!;
    const tree = serializeRoleTree(contract);
    expect(tree.has("framing.md")).toBe(true);
    expect(tree.has("system-prompt.md")).toBe(true);
    expect(tree.get("framing.md")).toBe(contract.framing);
    expect(tree.get("system-prompt.md")).toBe(contract.systemPrompt);
  });

  it("decomposes skills file-per-skill under skills/<name>/SKILL.md", () => {
    const { contract } = shippedContracts().find((c) => c.name === "worker")!;
    const tree = serializeRoleTree(contract);
    for (const skill of contract.skills) {
      expect(tree.get(`skills/${skill.name}/SKILL.md`)).toBe(skill.body);
    }
  });

  it("round-trips triggers file-per-trigger with filesystem-safe slugs", () => {
    const triggers: RoleTrigger[] = [
      { kind: "cron", expr: "*/5 * * * *" },
      { kind: "webhook", path: "/incoming/build" },
    ];
    const contract: RoleTreeContract = {
      framing: "f",
      systemPrompt: "s",
      skills: [],
      allowedTools: ["Bash"],
      allowedCliCommands: ["status"],
      hooks: "{}",
      triggers,
      seedRefs: [],
      wakePrograms: [],
      defaultWakeProgram: null,
      habits: [],
    };
    const tree = serializeRoleTree(contract);
    const triggerFiles = [...tree.keys()].filter((k) => k.startsWith("triggers/"));
    expect(triggerFiles.length).toBe(2);
    for (const key of triggerFiles) {
      expect(key).toMatch(/^triggers\/[a-z0-9-]+\.json$/);
    }
    const back = deserializeRoleTree(tree);
    const expected = [...triggers].sort((a, b) =>
      triggerId(a) < triggerId(b) ? -1 : triggerId(a) > triggerId(b) ? 1 : 0,
    );
    expect(back.triggers).toEqual(expected);
  });

  it("represents default-wake-program by file presence (worker has one, manager null)", () => {
    const worker = shippedContracts().find((c) => c.name === "worker")!;
    const manager = shippedContracts().find((c) => c.name === "manager")!;
    const workerDefault = worker.contract.defaultWakeProgram;
    if (workerDefault === null) throw new Error("expected worker to have a default wake-program");
    expect(serializeRoleTree(worker.contract).get("default-wake-program")).toBe(workerDefault);
    expect(serializeRoleTree(manager.contract).has("default-wake-program")).toBe(false);
    expect(manager.contract.defaultWakeProgram).toBeNull();
  });
});

// A simple three-way file merge — the union/disjoint behaviour git gives for
// free once the representation is decomposed. Lives in the test (real git merge
// is #349); here it only demonstrates that the *granularity* makes merges clean.
function threeWayMerge(base: RoleTree, a: RoleTree, b: RoleTree): RoleTree {
  const result = new Map(base);
  const apply = (side: RoleTree) => {
    for (const [key, value] of side) {
      const baseValue = base.get(key);
      if (baseValue === value) continue; // unchanged on this side
      const current = result.get(key);
      if (current !== undefined && current !== baseValue && current !== value) {
        throw new Error(`merge conflict on ${key}`);
      }
      result.set(key, value);
    }
  };
  apply(a);
  apply(b);
  return result;
}

describe("set-merge friendliness", () => {
  it("a skill added on each side both survive a three-way merge", () => {
    const { contract } = shippedContracts().find((c) => c.name === "worker")!;
    const base = serializeRoleTree(contract);

    const sideA = new Map(base);
    sideA.set("skills/alpha/SKILL.md", "---\nname: alpha\ndescription: a\n---\nalpha body\n");
    const sideB = new Map(base);
    sideB.set("skills/beta/SKILL.md", "---\nname: beta\ndescription: b\n---\nbeta body\n");

    const merged = threeWayMerge(base, sideA, sideB);
    const back = deserializeRoleTree(merged);
    const names = back.skills.map((s) => s.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
  });

  it("editing framing on one side and the system prompt on the other does not conflict", () => {
    const { contract } = shippedContracts().find((c) => c.name === "worker")!;
    const base = serializeRoleTree(contract);

    const sideA = new Map(base);
    sideA.set("framing.md", `${contract.framing}\nfork-A framing edit`);
    const sideB = new Map(base);
    sideB.set("system-prompt.md", `${contract.systemPrompt}\nfork-B prompt edit`);

    const merged = threeWayMerge(base, sideA, sideB); // must not throw
    const back = deserializeRoleTree(merged);
    expect(back.framing).toContain("fork-A framing edit");
    expect(back.systemPrompt).toContain("fork-B prompt edit");
  });
});

// #450 — companion files: any file alongside SKILL.md in a skill's directory
// should survive the codec round-trip and materialize to the runtime surface.
// readSkills today silently drops companions; serializeRoleTree doesn't emit them.

const MINIMAL_TREE: ReadonlyMap<string, string> = new Map([
  ["framing.md", "f"],
  ["system-prompt.md", "s"],
  ["hooks.json", "{}"],
  ["allowed-tools.txt", ""],
  ["allowed-cli-commands.txt", ""],
  ["seed-refs.json", "[]"],
]);

describe("#450 companion files in skill directories", () => {
  it("a companion file alongside SKILL.md is captured in skill.files after deserialize", () => {
    const tree = new Map(MINIMAL_TREE);
    tree.set("skills/my-skill/SKILL.md", "skill body");
    tree.set("skills/my-skill/context.md", "companion content");

    const contract = deserializeRoleTree(tree);
    const skill = contract.skills.find((s) => s.name === "my-skill");
    expect(skill?.files).toEqual({ "context.md": "companion content" });
  });

  it("multiple companions in the same skill dir are all captured", () => {
    const tree = new Map(MINIMAL_TREE);
    tree.set("skills/my-skill/SKILL.md", "body");
    tree.set("skills/my-skill/context.md", "ctx");
    tree.set("skills/my-skill/runbook.md", "runbook");

    const contract = deserializeRoleTree(tree);
    const skill = contract.skills.find((s) => s.name === "my-skill");
    expect(skill?.files).toEqual({ "context.md": "ctx", "runbook.md": "runbook" });
  });

  it("serializeRoleTree emits companion files under skills/<name>/", () => {
    const contract: RoleTreeContract = {
      framing: "f",
      systemPrompt: "s",
      skills: [{ name: "my-skill", body: "body", files: { "context.md": "companion" } }],
      allowedTools: [],
      allowedCliCommands: [],
      hooks: "{}",
      triggers: [],
      seedRefs: [],
      wakePrograms: [],
      defaultWakeProgram: null,
      habits: [],
    };
    const tree = serializeRoleTree(contract);
    expect(tree.get("skills/my-skill/SKILL.md")).toBe("body");
    expect(tree.get("skills/my-skill/context.md")).toBe("companion");
  });

  it("companion files survive a full serialize → deserialize round-trip", () => {
    const treeIn = new Map(MINIMAL_TREE);
    treeIn.set("skills/my-skill/SKILL.md", "body");
    treeIn.set("skills/my-skill/context.md", "companion");

    const contract = deserializeRoleTree(treeIn);
    const treeOut = serializeRoleTree(contract);

    expect(treeOut.get("skills/my-skill/context.md")).toBe("companion");
    // SKILL.md must still be present
    expect(treeOut.get("skills/my-skill/SKILL.md")).toBe("body");
  });

  it("readSkills throws when SKILL.md is absent (companion-only skill dir is malformed)", () => {
    const tree = new Map(MINIMAL_TREE);
    tree.set("skills/my-skill/context.md", "orphan companion — no SKILL.md");

    expect(() => deserializeRoleTree(tree)).toThrow(/SKILL\.md/);
  });
});

// #450 ENGINE_CONTRACT_VERSION proof: the `files` field is optional so a pre-files
// skills_json row (no `files` key) parses cleanly — no version bump is needed.
describe("#450 ENGINE_CONTRACT_VERSION backward-compat", () => {
  it("roleSnapshotToContract parses pre-files skills_json (no files key) without error", () => {
    // Simulate a skills_json authored before #450 — no `files` field on skills.
    const preFilesSkillsJson = JSON.stringify([
      { name: "status", body: "# status" },
      { name: "spawn", body: "# spawn" },
    ]);
    const snapshot = {
      framing: "",
      system_prompt: "prompt",
      skills_json: preFilesSkillsJson,
      allowed_tools_json: "[]",
      allowed_cli_commands_json: "[]",
      hooks_json: "{}",
      triggers_json: "[]",
      seed_refs_json: "[]",
      wake_programs_json: "[]",
      default_wake_program: null,
    };
    const contract = roleSnapshotToContract(snapshot);
    expect(contract.skills).toHaveLength(2);
    // Pre-files skills parse cleanly; files is absent (undefined), not an error.
    expect(contract.skills[0]?.files).toBeUndefined();
    expect(contract.skills[1]?.files).toBeUndefined();
  });
});
