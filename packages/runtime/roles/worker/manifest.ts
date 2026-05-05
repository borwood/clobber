import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRole } from "../../src/role-manifest/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export const workerRole = defineRole({
  root: HERE,
  manifest: {
    name: "worker",
    description:
      "Short-lived focused worker. Receives a single task from the manager, completes it, reports back, exits.",
    systemPromptPath: "system-prompt.md",
    pluginTemplatePath: "plugin-template",
    allowedCliCommands: ["whoami", "ask", "status"],
    persistent: false,
    defaultCeiling: 3,
    permissionMode: "bypassPermissions",
    allowedTools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
  },
});
