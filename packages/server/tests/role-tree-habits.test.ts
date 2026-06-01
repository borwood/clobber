import { describe, it, expect } from "bun:test";
import { HabitSchema, type Habit } from "@clobber/shared";
import {
  serializeRoleTree,
  deserializeRoleTree,
  type RoleTree,
  type RoleTreeContract,
} from "../src/role-tree.ts";

// #407 Phase 0 — the role-tree store grows a file-per-habit codec:
//   habits/<category>/<event>/<name>.json
// One habit per file is the merge-clean granularity (narrative #95): two habits
// on different files survive a three-way merge without conflict.

function habit(partial: unknown): Habit {
  return HabitSchema.parse(partial);
}

function baseContract(habits: readonly Habit[]): RoleTreeContract {
  return {
    framing: "f",
    systemPrompt: "s",
    skills: [],
    allowedTools: ["Bash"],
    allowedCliCommands: ["status"],
    hooks: "{}",
    triggers: [],
    seedRefs: [],
    wakePrograms: [],
    defaultWakeProgram: null,
    habits,
  };
}

const toolHabit = habit({
  path: "self.tool-use",
  phase: "pre",
  match: "Bash",
  name: "warn-on-bash",
  action: { kind: "inject", hint: "double-check the command" },
});
const cronHabit = habit({
  path: "system.cron",
  expr: "*/5 * * * *",
  name: "heartbeat",
  action: { kind: "cli", verb: "status" },
});

describe("role-tree habit codec", () => {
  it("writes one file per habit at habits/<category>/<event>/<name>.json", () => {
    const tree = serializeRoleTree(baseContract([toolHabit, cronHabit]));
    expect(tree.has("habits/self/tool-use/warn-on-bash.json")).toBe(true);
    expect(tree.has("habits/system/cron/heartbeat.json")).toBe(true);
  });

  it("round-trips habits contract → tree → contract", () => {
    const contract = baseContract([toolHabit, cronHabit]);
    const back = deserializeRoleTree(serializeRoleTree(contract));
    expect(back.habits).toEqual([cronHabit, toolHabit].sort((a, b) => (a.path < b.path ? -1 : 1)));
  });

  it("the habit file content is the full validated habit JSON", () => {
    const tree = serializeRoleTree(baseContract([toolHabit]));
    const raw = tree.get("habits/self/tool-use/warn-on-bash.json")!;
    expect(HabitSchema.parse(JSON.parse(raw))).toEqual(toolHabit);
  });
});

// A simple three-way file merge — the union/disjoint behaviour git gives for
// free once the representation is file-per-habit. Mirrors the skills/triggers
// proof in role-tree-roundtrip.test.ts.
function threeWayMerge(base: RoleTree, a: RoleTree, b: RoleTree): RoleTree {
  const result = new Map(base);
  const apply = (side: RoleTree) => {
    for (const [key, value] of side) {
      const baseValue = base.get(key);
      if (baseValue === value) continue;
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

describe("habit merge-clean fixture", () => {
  it("two habits added on different files both survive a three-way merge", () => {
    const base = serializeRoleTree(baseContract([]));

    const sideA = serializeRoleTree(baseContract([toolHabit]));
    const sideB = serializeRoleTree(baseContract([cronHabit]));

    const merged = threeWayMerge(base, sideA, sideB); // must not throw
    const back = deserializeRoleTree(merged);
    const names = back.habits.map((h) => h.name);
    expect(names).toContain("warn-on-bash");
    expect(names).toContain("heartbeat");
  });
});
