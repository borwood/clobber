import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRole } from "../../src/role-manifest/index.ts";
import { baseRole } from "../base/manifest.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// The `orient` opening move (layer C): the readiness sweep the manager runs
// when woken to take stock. Defined here, but NOT the manager's default — the
// default flip to `idle` (so a human tap is a conversation, not a forced orient)
// is #215. Selection wires up in #213.
const orientProgramSystem = readFileSync(join(HERE, "wake-programs/orient.md"), "utf8");

// The `bootstrap-interview` opening move (#685): the first-open interview.
// Selected only by the guarded workspace-open trigger below — never the
// manager's default wake-program — so a plain spawn or a human tap still
// boots idle.
const bootstrapInterviewProgramSystem = readFileSync(
  join(HERE, "wake-programs/bootstrap-interview.md"),
  "utf8",
);

export const managerRole = defineRole({
  root: HERE,
  base: baseRole,
  manifest: {
    name: "manager",
    description:
      "Permanent inhabitant of a workspace. Decomposes work, spawns workers, asks the user when blocked.",
    systemPromptPath: "system-prompt.md",
    framingPath: "framing.md",
    pluginTemplatePath: "plugin-template",
    allowedCliCommands: ["*"],
    persistent: true,
    defaultCeiling: 1,
    // permissionMode + allowedTools are inherited from `base` (#355).
    effort: "xhigh",
    // The manager alone receives the wisdom-pointer (the #166 boot-context
    // pointer, now a role-scoped seed): orchestration wisdom is a manager
    // concern, not a worker one.
    promptModuleRefs: [
      { name: "office-manifest", enabled: true },
      { name: "repo-sdlc", enabled: true },
      { name: "wisdom-pointer", enabled: true },
      { name: "roles-drift-sweep", enabled: true },
    ],
    // #348 canonicalizes wake-programs (and skills/triggers/habits) by name on
    // every git-tree round-trip — declare them pre-sorted so the shipped-bundle
    // snapshot already matches that canonical order (role-tree-roundtrip.test.ts).
    wakePrograms: [
      {
        name: "bootstrap-interview",
        system: bootstrapInterviewProgramSystem,
        user:
          "This looks like the first time this workspace has been opened. Run " +
          "your bootstrap-interview skill now.",
      },
      {
        name: "orient",
        system: orientProgramSystem,
        user:
          "You've been woken to take stock. Run your orientation sweep, then " +
          "summarise what changed and what needs a decision now.",
      },
    ],
    // #685 — first-open detection reuses workspace-open + a guard, rather than a
    // new trigger kind: the trigger fires on every open, but the guard suppresses
    // it once `.clobber/bootstrap.json` exists, so the interview runs exactly
    // once per workspace (until the sentinel is deleted).
    triggers: [
      {
        kind: "workspace-open",
        wake_program: "bootstrap-interview",
        guard: { kind: "file-absent", path: ".clobber/bootstrap.json" },
      },
    ],
  },
});
