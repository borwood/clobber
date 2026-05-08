import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRole } from "../../src/role-manifest/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export const workerBeeRole = defineRole({
  root: HERE,
  manifest: {
    name: "worker-bee",
    description:
      "Autonomous SDLC worker. Spawned with one issue assignment; walks research → failing-test → implement → open-pr → watch-ci unattended; reports back via final-report.",
    systemPromptPath: "system-prompt.md",
    pluginTemplatePath: "plugin-template",
    allowedCliCommands: ["whoami", "ask", "status", "report"],
    persistent: false,
    defaultCeiling: 3,
    permissionMode: "bypassPermissions",
    allowedTools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
  },
});
