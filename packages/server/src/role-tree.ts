import {
  HabitSchema,
  RoleSkillSchema,
  RoleTriggerSchema,
  SeedRefsSchema,
  WakeProgramsSchema,
  triggerId,
  type Habit,
  type RoleSkill,
  type RoleTrigger,
  type SeedRef,
  type WakeProgram,
} from "@clobber/shared";
import { z } from "zod";
import type { RoleVersionSnapshot } from "./role-version-snapshot.ts";

// #348 — the canonical role ↔ git-tree representation.
//
// `snapshotShippedBundle` (role-version-snapshot.ts) FLATTENS a role's file tree
// into the JSON-string columns of a role version. This module is the inverse: it
// DECOMPOSES those fields into a merge-friendly file tree and reads it back,
// losslessly. EPIC #346 (git-as-truth) stores roles as commits in a git repo;
// `git merge` upstream is how a fork takes an engine upgrade. Whether that merge
// is clean is a function of how granular the representation is.
//
// THE DECOMPOSITION RULE (spike-validated): never flatten a mergeable set into
// one blob. A skills *directory* merges clean across independent base/fork
// additions; a single-file prompt conflicts on adjacent edits. So every set of
// independently-authored units becomes file-per-unit, and the two prompt layers
// (role framing vs static prompt) stay in separate files so an engine edit and a
// local edit never share one.
//
// FIELD → FILE MAPPING
//   framing.md                      role framing            (prompt layer A)
//   system-prompt.md                static role prompt      (prompt layer B)
//   hooks.json                      hooks (verbatim)        natural unit: structured JSON kept whole
//   allowed-tools.txt               tool allow-list         one per line — git union-merges additions
//   allowed-cli-commands.txt        cli allow-list          one per line
//   seed-refs.json                  ordered seed refs       single file — order is composition order
//   default-wake-program            default opening move    one line; file ABSENT ⇒ null
//   skills/<name>/SKILL.md          one skill               file-per-skill (already the shipped layout)
//   wake-programs/<name>/system.md  a program's layer-C     file-per-program
//   wake-programs/<name>/user.md    a program's kick        ABSENT ⇒ null kick
//   triggers/<slug>.json            one trigger             file-per-trigger
//   habits/<category>/<event>/<name>.json   one habit       file-per-habit (#398/#407)
//
// The engine base preamble (CLOBBER_TAG_INTERPRETATION_GUIDANCE) is composed at
// runtime, not stored per role, so the stored prompt is exactly these two layer
// files. This is the version-store representation; it is distinct from
// `materializeBundle`, which writes the live *runtime plugin* layout for a spawn.

export interface RoleTreeContract {
  readonly framing: string;
  readonly systemPrompt: string;
  readonly skills: readonly RoleSkill[];
  readonly allowedTools: readonly string[];
  readonly allowedCliCommands: readonly string[];
  readonly hooks: string;
  readonly triggers: readonly RoleTrigger[];
  readonly seedRefs: readonly SeedRef[];
  readonly wakePrograms: readonly WakeProgram[];
  readonly defaultWakeProgram: string | null;
  // #398/#407 — habits live in the role git tree, file-per-habit. They are NOT
  // (yet) flattened into a role-version column, so the snapshot ↔ contract
  // converters carry an empty set; the git tree is the only store in Phase 0.
  readonly habits: readonly Habit[];
}

// A role's tree is a flat map of repo-relative path → file content. Keeping it
// in-memory (rather than on disk) makes the representation pure and testable;
// committing it to a git repo is #349's concern.
export type RoleTree = ReadonlyMap<string, string>;

const ToolListSchema = z.array(z.string().min(1));
const TriggersSchema = z.array(RoleTriggerSchema);
const SkillsSchema = z.array(RoleSkillSchema);

const byName = <T extends { name: string }>(a: T, b: T): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const byTriggerId = (a: RoleTrigger, b: RoleTrigger): number => {
  const ia = triggerId(a);
  const ib = triggerId(b);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
};

// Habits are identified by (path, name) — the same tuple their file path encodes.
const byHabit = (a: Habit, b: Habit): number => {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

// Sets resolved by name/identity are normalized so the contract has one
// canonical form: skills and wake-programs by name, triggers by trigger id.
// seedRefs and the allow-lists keep their order — there order is meaning.
function canonicalize(c: RoleTreeContract): RoleTreeContract {
  return {
    ...c,
    skills: [...c.skills].sort(byName),
    wakePrograms: [...c.wakePrograms].sort(byName),
    triggers: [...c.triggers].sort(byTriggerId),
    habits: [...c.habits].sort(byHabit),
  };
}

export function roleSnapshotToContract(snapshot: RoleVersionSnapshot): RoleTreeContract {
  return canonicalize({
    framing: snapshot.framing,
    systemPrompt: snapshot.system_prompt,
    skills: SkillsSchema.parse(JSON.parse(snapshot.skills_json)),
    allowedTools: ToolListSchema.parse(JSON.parse(snapshot.allowed_tools_json)),
    allowedCliCommands: ToolListSchema.parse(JSON.parse(snapshot.allowed_cli_commands_json)),
    hooks: snapshot.hooks_json,
    triggers: TriggersSchema.parse(JSON.parse(snapshot.triggers_json)),
    seedRefs: SeedRefsSchema.parse(JSON.parse(snapshot.seed_refs_json)),
    wakePrograms: WakeProgramsSchema.parse(JSON.parse(snapshot.wake_programs_json)),
    defaultWakeProgram: snapshot.default_wake_program,
    // Phase 0: habits are git-tree-only; the role-version snapshot has no column.
    habits: [],
  });
}

export function roleContractToSnapshot(contract: RoleTreeContract): RoleVersionSnapshot {
  return {
    framing: contract.framing,
    system_prompt: contract.systemPrompt,
    skills_json: JSON.stringify(contract.skills),
    allowed_tools_json: JSON.stringify(contract.allowedTools),
    allowed_cli_commands_json: JSON.stringify(contract.allowedCliCommands),
    hooks_json: contract.hooks,
    triggers_json: JSON.stringify(contract.triggers),
    seed_refs_json: JSON.stringify(contract.seedRefs),
    wake_programs_json: JSON.stringify(contract.wakePrograms),
    default_wake_program: contract.defaultWakeProgram,
  };
}

// One token per line; the trailing newline keeps the file POSIX-clean and lets
// git union-merge an addition on each side. Order is preserved.
function toLines(items: readonly string[]): string {
  return items.map((item) => `${item}\n`).join("");
}

function fromLines(content: string): string[] {
  return content.split("\n").filter((line) => line.length > 0);
}

function toJsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// `triggerId()` carries `:` and `/` (e.g. `webhook:/incoming/build`) which can't
// be a filename; the slug is a stable filesystem-safe handle. The file CONTENT
// (full trigger JSON) is the source of truth — the slug is never parsed back.
function triggerSlug(trigger: RoleTrigger): string {
  return triggerId(trigger)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function serializeRoleTree(contract: RoleTreeContract): RoleTree {
  const tree = new Map<string, string>();

  tree.set("framing.md", contract.framing);
  tree.set("system-prompt.md", contract.systemPrompt);
  tree.set("hooks.json", contract.hooks);
  tree.set("allowed-tools.txt", toLines(contract.allowedTools));
  tree.set("allowed-cli-commands.txt", toLines(contract.allowedCliCommands));
  tree.set("seed-refs.json", toJsonFile(contract.seedRefs));

  if (contract.defaultWakeProgram !== null) {
    tree.set("default-wake-program", contract.defaultWakeProgram);
  }

  for (const skill of contract.skills) {
    tree.set(`skills/${skill.name}/SKILL.md`, skill.body);
  }

  for (const program of contract.wakePrograms) {
    tree.set(`wake-programs/${program.name}/system.md`, program.system);
    if (program.user !== null) {
      tree.set(`wake-programs/${program.name}/user.md`, program.user);
    }
  }

  const slugs = new Set<string>();
  for (const trigger of contract.triggers) {
    const slug = triggerSlug(trigger);
    if (slugs.has(slug)) {
      throw new Error(`trigger slug collision: ${slug} (from ${triggerId(trigger)})`);
    }
    slugs.add(slug);
    tree.set(`triggers/${slug}.json`, toJsonFile(trigger));
  }

  // habits/<category>/<event>/<name>.json — the file path is derived from the
  // habit's own (path, name), so two habits on different events never share a
  // file and a git merge of independent additions is clean.
  for (const habit of contract.habits) {
    const file = habitFile(habit);
    if (tree.has(file)) {
      throw new Error(`habit file collision: ${file}`);
    }
    tree.set(file, toJsonFile(habit));
  }

  return tree;
}

function habitFile(habit: Habit): string {
  const [category, event] = habit.path.split(".");
  return `habits/${category}/${event}/${habit.name}.json`;
}

function requireFile(tree: RoleTree, path: string): string {
  const value = tree.get(path);
  if (value === undefined) {
    throw new Error(`role tree is missing required file: ${path}`);
  }
  return value;
}

function readSkills(tree: RoleTree): RoleSkill[] {
  const skills: RoleSkill[] = [];
  for (const [path, body] of tree) {
    if (!/^skills\/[^/]+\/SKILL\.md$/.test(path)) continue;
    const name = path.slice("skills/".length, -"/SKILL.md".length);
    skills.push({ name, body });
  }
  return skills.sort(byName);
}

function readWakePrograms(tree: RoleTree): WakeProgram[] {
  const systems = new Map<string, string>();
  const users = new Map<string, string>();
  for (const [path, content] of tree) {
    if (!/^wake-programs\/[^/]+\/(system|user)\.md$/.test(path)) continue;
    if (path.endsWith("/system.md")) {
      systems.set(path.slice("wake-programs/".length, -"/system.md".length), content);
    } else {
      users.set(path.slice("wake-programs/".length, -"/user.md".length), content);
    }
  }
  const programs: WakeProgram[] = [];
  for (const [name, system] of systems) {
    const user = users.get(name);
    programs.push({ name, system, user: user === undefined ? null : user });
  }
  return programs.sort(byName);
}

function readTriggers(tree: RoleTree): RoleTrigger[] {
  const triggers: RoleTrigger[] = [];
  for (const [path, content] of tree) {
    if (!/^triggers\/[^/]+\.json$/.test(path)) continue;
    triggers.push(RoleTriggerSchema.parse(JSON.parse(content)));
  }
  return triggers.sort(byTriggerId);
}

function readHabits(tree: RoleTree): Habit[] {
  const habits: Habit[] = [];
  for (const [path, content] of tree) {
    if (!/^habits\/[^/]+\/[^/]+\/[^/]+\.json$/.test(path)) continue;
    habits.push(HabitSchema.parse(JSON.parse(content)));
  }
  return habits.sort(byHabit);
}

export function deserializeRoleTree(tree: RoleTree): RoleTreeContract {
  const defaultWakeProgram = tree.get("default-wake-program");
  return {
    framing: requireFile(tree, "framing.md"),
    systemPrompt: requireFile(tree, "system-prompt.md"),
    hooks: requireFile(tree, "hooks.json"),
    allowedTools: fromLines(requireFile(tree, "allowed-tools.txt")),
    allowedCliCommands: fromLines(requireFile(tree, "allowed-cli-commands.txt")),
    seedRefs: SeedRefsSchema.parse(JSON.parse(requireFile(tree, "seed-refs.json"))),
    skills: readSkills(tree),
    wakePrograms: readWakePrograms(tree),
    triggers: readTriggers(tree),
    habits: readHabits(tree),
    defaultWakeProgram: defaultWakeProgram === undefined ? null : defaultWakeProgram,
  };
}
