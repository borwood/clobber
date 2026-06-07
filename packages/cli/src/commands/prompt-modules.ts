import type { Command, Subcommand } from "../commands.ts";
import { CliUsageError } from "../usage-error.ts";
import { runList } from "./prompt-modules-list.ts";
import { runShow } from "./prompt-modules-show.ts";
import { runCreate } from "./prompt-modules-create.ts";
import { runEdit } from "./prompt-modules-edit.ts";
import { runDelete } from "./prompt-modules-delete.ts";

// list/show/create/delete call /workspaces/* routes (no withAgentAuth).
// edit calls /agent/prompt-modules/:name (withAgentAuth "prompt-modules.edit").
const SUBCOMMANDS: readonly Subcommand[] = [
  { name: "list" },
  { name: "show" },
  { name: "create" },
  { name: "edit", capability: "prompt-modules.edit" },
  { name: "delete" },
];

function isSubcommand(name: string): boolean {
  return SUBCOMMANDS.some((s) => s.name === name);
}

const PROMPT_MODULES_USAGE = `usage: clobber prompt-modules <subcommand> [flags]

Subcommands:

  list [--json]
    List the resolved catalog: name · kind · source (shipped-default | workspace | shadows-default).

  show <name> [--json]
    Show the full definition of a module. Dynamic (exec/http) providers are shown
    prominently — they run code at compose time.

  create <name> (--static-file FILE | --static - | --exec '<cmd>' [--exec-arg <val>]...
                | --http <url> [--http-header k:v]...) [--json]
    Create a new module. Refuses if a workspace module of that name already exists.
    Creating a shipped-default name forks a workspace shadow.

  edit <name> (same provider flags as create) [--json]
    Replace a module's definition. Editing a shipped-default name forks a workspace
    shadow (prints a notice). Returns 404 for names unknown to both catalog and defaults.

  delete <name> [--force] [--json]
    Delete a workspace module. Pure shipped defaults cannot be deleted.
    Refuses if any role still refs it unless --force is given.`;

export const promptModulesCommand: Command = {
  name: "prompt-modules",
  summary: "Manage the workspace prompt-module catalog (list / show / create / edit / delete).",
  usage: PROMPT_MODULES_USAGE,
  subcommands: SUBCOMMANDS,
  async run(ctx) {
    const [sub, ...rest] = ctx.args;
    if (sub === undefined) {
      throw new CliUsageError("prompt-modules: missing subcommand");
    }
    if (!isSubcommand(sub)) {
      throw new CliUsageError(`prompt-modules: unknown subcommand: ${sub}`);
    }
    if (sub === "list") return runList(ctx, rest);
    if (sub === "show") return runShow(ctx, rest);
    if (sub === "create") return runCreate(ctx, rest);
    if (sub === "edit") return runEdit(ctx, rest);
    return runDelete(ctx, rest);
  },
};
