import type { Command, Subcommand } from "../commands.ts";
import { CliUsageError } from "../usage-error.ts";
import { WORKSPACE_CONFIG_FILE, MANAGER_TRIGGERS_FILE, runCreate } from "./workspace-create.ts";
import { runPatch } from "./workspace-patch.ts";
import { runPermsShow, runPermsSet } from "./workspace-perms.ts";

// workspace create/patch/perms call /workspaces/* routes (no withAgentAuth), so
// no capability ref — they operate outside the agent-authz layer.
const SUBCOMMANDS: readonly Subcommand[] = [
  { name: "create" },
  { name: "patch" },
  { name: "perms" },
];

function isSubcommand(name: string): boolean {
  return SUBCOMMANDS.some((s) => s.name === name);
}

const WORKSPACE_USAGE = `usage: clobber workspace <subcommand> [flags]

Subcommands:

  create --config <dir> [--json]
    Load a workspace from an example directory in one step. Reads
    ${WORKSPACE_CONFIG_FILE} and ${MANAGER_TRIGGERS_FILE} from <dir>.

  patch [--allow-skill <name>] [--disallow-skill <name>]
        [--allow-self-grant true|false] [--json <body>|--json]
    Patch the current workspace's live config. At least one field flag is
    required. Resolves the workspace from the calling agent's session.

    --allow-skill <name>      Append a skill to manager_skill_policy.allowed_skills
                              (repeatable; deduplicated; read-modify-write).
    --disallow-skill <name>   Remove a skill from allowed_skills (repeatable; RMW).
    --allow-self-grant <bool> Set manager_skill_policy.allow_self_grant (true|false).
    --json <body>             Merge a raw JSON object into the PATCH body (escape hatch
                              for fields without a bespoke flag). Also enables JSON output.
    --json                    Emit the updated workspace as JSON (no body arg = output only).

  perms show [--json]
    Print the workspace-level CLI permissions scope (allow + deny lists).

  perms set --allow <tok>... --deny <tok>... [--json]
    Replace the workspace-level permissions scope. Tokens follow the same
    grammar as role allow-lists: "*", "tag:<read|write|admin>", "verb.*",
    exact verb names; deny tokens must be prefixed with "!".
    At least one --allow or --deny token is required.

Examples:
  clobber workspace create --config examples/clobber-on-clobber/
  clobber workspace patch --allow-skill clobber-pm --allow-self-grant true
  clobber workspace patch --disallow-skill old-skill
  clobber workspace patch --json '{"theme":{"accent":"blue"}}'
  clobber workspace perms show
  clobber workspace perms set --allow "*" --deny "!spawn"
  clobber workspace perms set --allow "tag:read" --json`;

export const workspaceCommand: Command = {
  name: "workspace",
  summary: "Load or patch a workspace (create + apply triggers, or live config patch).",
  usage: WORKSPACE_USAGE,
  subcommands: SUBCOMMANDS,
  async run(ctx) {
    const [sub, ...rest] = ctx.args;
    if (sub === undefined) {
      throw new CliUsageError("workspace: missing subcommand (create, patch, or perms)");
    }
    if (!isSubcommand(sub)) {
      throw new CliUsageError(`workspace: unknown subcommand: ${sub}`);
    }
    if (sub === "create") return runCreate(ctx, rest);
    if (sub === "perms") {
      const [permsCmd, ...permsRest] = rest;
      if (permsCmd === "show") return runPermsShow(ctx, permsRest);
      if (permsCmd === "set") return runPermsSet(ctx, permsRest);
      throw new CliUsageError("workspace perms: subcommand must be 'show' or 'set'");
    }
    return runPatch(ctx, rest);
  },
};
