import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRole } from "../../src/role-manifest/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export const managerRole = defineRole({
  root: HERE,
  manifest: {
    name: "manager",
    description:
      "Permanent inhabitant of a workspace. Decomposes work, spawns workers, asks the user when blocked.",
    systemPromptPath: "system-prompt.md",
    settingsOverlayPath: "settings.overlay.json",
    allowedCliCommands: ["whoami", "spawn", "ask", "status"],
    skills: [
      { name: "whoami", path: "skills/whoami.md" },
      { name: "spawn", path: "skills/spawn.md" },
      { name: "ask", path: "skills/ask.md" },
      { name: "status", path: "skills/status.md" },
    ],
    hookScripts: [],
  },
});
