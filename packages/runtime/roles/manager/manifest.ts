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
      // Disabled by default: the http provider calls the running server at apiBase,
      // which is not configured in the engine default. Enable via `clobber roles`
      // on the workspace fork once clobber is deployed (#401 step-2).
      { name: "roles-drift-sweep", enabled: false },
    ],
    wakePrograms: [
      {
        name: "orient",
        system: orientProgramSystem,
        user:
          "You've been woken to take stock. Run your orientation sweep, then " +
          "summarise what changed and what needs a decision now.",
      },
    ],
  },
});
