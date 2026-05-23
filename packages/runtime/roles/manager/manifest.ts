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
    pluginTemplatePath: "plugin-template",
    allowedCliCommands: ["*"],
    persistent: true,
    defaultCeiling: 1,
    permissionMode: "bypassPermissions",
    allowedTools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
    effort: "xhigh",
  },
});
