import type { Command, CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";
import { takeJsonFlag } from "./roles-args.ts";
import { runList, runShow } from "./roles-inspect.ts";
import { runEdit } from "./roles-edit.ts";
import { runDelete } from "./roles-delete.ts";
import { runPromptModules } from "./roles-prompt-modules.ts";
import { runWakePrograms } from "./roles-wake-programs.ts";
import {
  forkRoleBranch,
  runCheckout,
  runCheckoutStatus,
  runCommit,
  runDiff,
  runDiscard,
} from "./roles-checkout.ts";
import { runFetch, runLogUpstream } from "./roles-upstream.ts";

const SUBCOMMANDS = [
  "list",
  "show",
  "fork",
  "edit",
  "delete",
  "ceiling",
  "prompt-modules",
  "wake-programs",
  "checkout",
  "status",
  "diff",
  "commit",
  "discard",
  "fetch",
  "log",
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(name: string): name is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(name);
}

function assertNoArgs(sub: string, args: readonly string[]): void {
  if (args.length > 0) {
    throw new CliUsageError(`roles ${sub}: unexpected arguments: ${args.join(" ")}`);
  }
}

// `roles fork <source> <new>` is a thin alias for `roles checkout -b <new>
// --from <source>` — both call forkRoleBranch (one server operation: create a
// role as a fresh git branch off the source tip, commit-pinned, no version row).
async function runFork(
  ctx: CommandContext,
  json: boolean,
  rest: readonly string[],
): Promise<number> {
  const [source, newName, ...extra] = rest;
  if (source === undefined) {
    throw new CliUsageError(
      "roles fork: missing source name or id (usage: `roles fork <source-name|id> <new-name>`)",
    );
  }
  if (newName === undefined) {
    throw new CliUsageError(
      "roles fork: missing new-name (usage: `roles fork <source-name|id> <new-name>`)",
    );
  }
  if (extra.length > 0) {
    throw new CliUsageError(
      `roles fork: unexpected arguments: ${extra.join(" ")}`,
    );
  }
  return forkRoleBranch(ctx, json, source, newName);
}

interface CeilingResponse {
  readonly workspace_id: string;
  readonly role_id: string;
  readonly max_concurrent: number;
}

async function runCeiling(
  ctx: CommandContext,
  json: boolean,
  rest: readonly string[],
): Promise<number> {
  const [target, raw, ...extra] = rest;
  if (target === undefined) {
    throw new CliUsageError(
      "roles ceiling: missing role name or id (usage: `roles ceiling <name|id> <max>`)",
    );
  }
  if (raw === undefined) {
    throw new CliUsageError(
      "roles ceiling: missing max_concurrent (usage: `roles ceiling <name|id> <max>`)",
    );
  }
  if (extra.length > 0) {
    throw new CliUsageError(
      `roles ceiling: unexpected arguments: ${extra.join(" ")}`,
    );
  }
  if (!/^\d+$/.test(raw)) {
    throw new CliUsageError(
      `roles ceiling: max_concurrent must be a non-negative integer, got: ${raw}`,
    );
  }
  const max = Number(raw);
  const result = await request<CeilingResponse>(ctx.env, {
    method: "PUT",
    path: `/agent/roles/${encodeURIComponent(target)}/ceiling`,
    body: { max_concurrent: max },
  });
  if (json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  ctx.stdout.write(`set ceiling on ${target} -> ${result.max_concurrent}\n`);
  return 0;
}

export const rolesCommand: Command = {
  name: "roles",
  summary: "List or inspect roles available in the current workspace.",
  usage:
    "usage: clobber roles <list|show|fork|edit|delete|ceiling|prompt-modules|wake-programs|checkout|status|diff|commit|discard|fetch|log> [args...]\n\n" +
    "Subcommands:\n" +
    "  roles list [--json]                          List workspace roles with version metadata.\n" +
    "  roles show <name|id> [--json]                Show full role + current version + history.\n" +
    "  roles fork <source-name|id> <new-name> [--json]  Alias for `checkout -b <new-name> --from <source>`.\n" +
    "  roles edit <name|id> [flags] [--json]        One-shot patch a role; system_prompt/skills/allowed_tools/triggers/prompt-modules/wake-programs advance the git pin (no version row), description is metadata-only.\n" +
    "  roles delete <name|id> [--force] [--json]    Remove a role + its fork-branch + config refs. Refused for persistent / spawned-agent roles (use --force); a live session is a hard stop (reap it first).\n" +
    "  roles ceiling <name|id> <max> [--json]       Set the spawn ceiling for this role in this workspace.\n" +
    "  roles prompt-modules <name|id> [add|enable|disable <module> [--disabled]]  List a role's prompt-module refs, or add/toggle one.\n" +
    "  roles wake-programs <name|id> [show|add|edit|remove <name> ...]  List/show/author wake-programs (`idle` is the built-in).\n\n" +
    "Upstream verbs (compare local role state to engine defaults):\n" +
    "  roles fetch                                  Refresh upstream remote-tracking refs in the workspace clone.\n" +
    "  roles diff <name|id> @{upstream} [--json]    Line-level diff of local pin vs upstream default.\n" +
    "  roles log <name|id> @{upstream}.. [--json]   Commits on upstream not yet in local pin.\n\n" +
    "Working-copy verbs (edit a role like code — commit advances the git pin, no new version row):\n" +
    "  roles checkout <name|id> [--json]            Materialize the role's branch into the desk; edit the files, then commit.\n" +
    "  roles checkout -b <new-name> --from <src>    Create/fork a role as a fresh git branch off <src> (commit-pinned, no version row).\n" +
    "  roles status [--json]                        Is a checkout open? for which role? which files changed? stale?\n" +
    "  roles diff [--json]                          Show the working copy's changes against the branch tip.\n" +
    "  roles commit [-m <msg>] [--force] [--json]   Serialize the edits onto the branch + advance the pin (--force overrides a stale tip).\n" +
    "  roles discard [--json]                       Throw the checkout away (the branch is untouched).\n\n" +
    "Flags (roles edit):\n" +
    "  --system-prompt-file FILE      Replace system prompt from a file.\n" +
    "  --system-prompt -              Replace system prompt from stdin.\n" +
    "  --allowed-tools tool1,tool2    Replace the allowed tool list.\n" +
    "  --add-skill name=FILE|DIR      Add (or replace) a skill (repeatable).\n" +
    "  --remove-skill name            Remove a skill by name (repeatable).\n" +
    "  --description TEXT             Replace the role description (metadata-only; does not advance the pin).\n" +
    "  --description-file FILE        Replace the role description from a file.\n" +
    "  --triggers JSON                Replace triggers (JSON array of trigger objects, persistent roles only).\n" +
    "  --triggers-file FILE           Replace triggers from a JSON file.\n\n" +
    "Flags (roles wake-programs add|edit):\n" +
    "  --system TEXT | --system-file FILE   Layer-C system-prompt addon.\n" +
    "  --user TEXT | --no-user              Opening user-message kick, or none.\n\n" +
    "Example:\n" +
    "  clobber roles fork worker my-worker\n" +
    "  clobber roles prompt-modules my-worker add repo-sdlc\n" +
    "  clobber roles wake-programs my-worker add triage --system-file ./c.md --user \"Triage now.\"\n\n" +
    "Skill: see manager:roles for fork/edit/prompt-modules/wake-program patterns.\n",
  subcommands: SUBCOMMANDS,
  async run(ctx) {
    const [sub, ...rest] = ctx.args;
    if (sub === undefined) {
      throw new CliUsageError("roles: missing subcommand (try `roles list`)");
    }
    if (!isSubcommand(sub)) {
      throw new CliUsageError(`roles: unknown subcommand: ${sub}`);
    }
    if (sub === "edit") {
      return runEdit(ctx, rest);
    }
    if (sub === "prompt-modules") {
      return runPromptModules(ctx, rest);
    }
    if (sub === "wake-programs") {
      return runWakePrograms(ctx, rest);
    }
    const { json, rest: subArgs } = takeJsonFlag(rest);
    if (sub === "list") {
      if (subArgs.length > 0) {
        throw new CliUsageError(
          `roles list: unexpected arguments: ${subArgs.join(" ")}`,
        );
      }
      return runList(ctx, json);
    }
    if (sub === "fork") {
      return runFork(ctx, json, subArgs);
    }
    if (sub === "delete") {
      return runDelete(ctx, json, subArgs);
    }
    if (sub === "ceiling") {
      return runCeiling(ctx, json, subArgs);
    }
    if (sub === "checkout") {
      return runCheckout(ctx, json, subArgs);
    }
    if (sub === "status") {
      assertNoArgs("status", subArgs);
      return runCheckoutStatus(ctx, json);
    }
    if (sub === "diff") {
      return runDiff(ctx, json, subArgs);
    }
    if (sub === "commit") {
      return runCommit(ctx, json, subArgs);
    }
    if (sub === "discard") {
      assertNoArgs("discard", subArgs);
      return runDiscard(ctx, json);
    }
    if (sub === "fetch") {
      assertNoArgs("fetch", subArgs);
      return runFetch(ctx, json);
    }
    if (sub === "log") {
      return runLogUpstream(ctx, json, subArgs);
    }
    return runShow(ctx, json, subArgs);
  },
};
