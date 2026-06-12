import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRole } from "../../src/role-manifest/index.ts";
import { baseRole } from "../base/manifest.ts";
import { defaultSdlcProfile } from "../../src/sdlc-profiles.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// The `task` opening move — the worker's "read your desk NOW, start the SDLC"
// protocol (layer C), lifted out of the durable system prompt so the same role
// can also be spawned `idle` (oriented but waiting). The kick is the vestigial
// turn that points the worker at its desk; the assignment itself rides the desk.
const taskProgramSystem = readFileSync(join(HERE, "wake-programs/task.md"), "utf8");

export const workerRole = defineRole({
  root: HERE,
  base: baseRole,
  manifest: {
    name: "worker",
    description:
      "Autonomous SDLC worker. Spawned with one issue assignment; walks the SDLC profile's phases unattended; reports back via final-report.",
    systemPromptPath: "system-prompt.md",
    framingPath: "framing.md",
    pluginTemplatePath: "plugin-template",
    allowedCliCommands: ["whoami", "ask", "status", "report", "reply", "notify.list", "notify.ack", "worktrees.set"],
    persistent: false,
    defaultCeiling: 3,
    // permissionMode + allowedTools are inherited from `base` (#355).
    effort: "high",
    sdlc: defaultSdlcProfile,
    // No wisdom-pointer: that pointer is the manager's, and seeding it to every
    // worker was the original #166 mis-shape this issue fixes.
    promptModuleRefs: [{ name: "repo-sdlc", enabled: true }],
    wakePrograms: [
      {
        name: "task",
        system: taskProgramSystem,
        user:
          "You've been assigned work. Before anything else, run your desk protocol: " +
          "read your desk, lay down the boot-tasks phase plan, read the assignment, " +
          "then walk the SDLC to a merge-ready PR.",
      },
    ],
    // A worker spawned without an explicit selection opens on `task` — read the
    // desk, start the SDLC (#213). The manager omits this, so its spawns default
    // to idle.
    defaultWakeProgram: "task",
  },
});
