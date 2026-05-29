import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineBaseRole } from "../../src/role-manifest/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// `base` is the abstract universal layer every agent forks from (#355). It is
// never embodied — not in the shipped registry, never seeded, never spawned —
// so it carries no identity (framing / system prompt) and no role-specific
// skills. It owns only what is genuinely universal today:
//   - the observability mechanism (hooks.json) — byte-identical across forks,
//   - the baseline tool set, and
//   - the baseline permission mode.
// A fork that omits these inherits them, so a future base change merges down to
// every fork in one place instead of being duplicated per role.
export const baseRole = defineBaseRole({
  root: HERE,
  pluginTemplatePath: "plugin-template",
  permissionMode: "bypassPermissions",
  allowedTools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
});
