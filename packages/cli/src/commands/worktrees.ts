import type { Command, CommandContext, Subcommand } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

const SUBCOMMANDS: readonly Subcommand[] = [
  { name: "set",         capability: "worktrees.set" },
  { name: "set-agent",   capability: "worktrees.set-agent" },
  { name: "set-default", capability: "worktrees.set-default" },
];

function isSubcommand(name: string): boolean {
  return SUBCOMMANDS.some((s) => s.name === name);
}

interface SetResponse { readonly ok: boolean; readonly path: string }
interface SetDefaultResponse {
  readonly ok: boolean;
  readonly branch_prefix: string | null;
  readonly worktree_root: string | null;
}

// worktrees set <new-path>
async function runSet(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  const [path, ...extra] = rest;
  if (path === undefined) {
    throw new CliUsageError(
      "worktrees set: missing path (usage: `worktrees set <new-path>`)",
    );
  }
  if (extra.length > 0) {
    throw new CliUsageError(`worktrees set: unexpected arguments: ${extra.join(" ")}`);
  }
  const result = await request<SetResponse>(ctx.env, {
    method: "POST",
    path: "/agent/worktrees/set",
    body: { path },
  });
  ctx.stdout.write(`moved worktree to ${result.path}\n`);
  return 0;
}

// worktrees set-agent <agent-id> <new-path>
async function runSetAgent(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  const [agentId, path, ...extra] = rest;
  if (agentId === undefined) {
    throw new CliUsageError(
      "worktrees set-agent: missing agent-id (usage: `worktrees set-agent <agent-id> <new-path>`)",
    );
  }
  if (path === undefined) {
    throw new CliUsageError(
      "worktrees set-agent: missing path (usage: `worktrees set-agent <agent-id> <new-path>`)",
    );
  }
  if (extra.length > 0) {
    throw new CliUsageError(`worktrees set-agent: unexpected arguments: ${extra.join(" ")}`);
  }
  const result = await request<SetResponse>(ctx.env, {
    method: "POST",
    path: "/agent/worktrees/set-agent",
    body: { agent_id: agentId, path },
  });
  ctx.stdout.write(`moved agent ${agentId} worktree to ${result.path}\n`);
  return 0;
}

// worktrees set-default [<prefix>] [--worktree-root <path>]  (empty prefix = bare slug)
async function runSetDefault(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  const positionals: string[] = [];
  let worktreeRoot: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--worktree-root") {
      const val = rest[i + 1];
      if (val === undefined || val.startsWith("-")) {
        throw new CliUsageError("--worktree-root requires a value");
      }
      worktreeRoot = val;
      i++;
    } else if (arg.startsWith("-")) {
      throw new CliUsageError(`worktrees set-default: unknown flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length > 1) {
    throw new CliUsageError(
      `worktrees set-default: unexpected arguments: ${positionals.slice(1).join(" ")}`,
    );
  }

  const prefix = positionals[0];
  const body: { branch_prefix?: string; worktree_root?: string } = {};
  if (prefix !== undefined) body.branch_prefix = prefix;
  if (worktreeRoot !== undefined) body.worktree_root = worktreeRoot;

  const result = await request<SetDefaultResponse>(ctx.env, {
    method: "PUT",
    path: "/agent/worktrees/default",
    body,
  });
  if (prefix !== undefined) {
    const displayPrefix = result.branch_prefix !== null ? result.branch_prefix : "(bare slug)";
    ctx.stdout.write(`set workspace branch-prefix to: ${displayPrefix}\n`);
  }
  if (result.worktree_root !== null) {
    ctx.stdout.write(`set workspace worktree-root to: ${result.worktree_root}\n`);
  }
  return 0;
}

export const worktreesCommand: Command = {
  name: "worktrees",
  summary: "Move agent worktrees or configure the workspace branch-prefix convention.",
  usage:
    "usage: clobber worktrees <set|set-agent|set-default> [args...]\n\n" +
    "Subcommands:\n" +
    "  worktrees set <new-path>                              Move the caller's own worktree to a new path.\n" +
    "  worktrees set-agent <agent-id> <new-path>             Move a named (idle) agent's worktree to a new path.\n" +
    "  worktrees set-default [<prefix>] [--worktree-root <path>]\n" +
    "                                                        Set the workspace branch-prefix and/or worktree root\n" +
    "                                                        directory convention. Each field is updated independently;\n" +
    "                                                        omitting a field leaves its current value unchanged.\n" +
    "                                                        Explicit empty <prefix> (set-default \"\") clears to bare slug.\n\n" +
    "Examples:\n" +
    "  clobber worktrees set /data/worktrees/636\n" +
    "  clobber worktrees set-agent <uuid> /data/worktrees/old-worker\n" +
    "  clobber worktrees set-default clobber\n" +
    "  clobber worktrees set-default\n" +
    "  clobber worktrees set-default clobber --worktree-root /mnt/fast-ssd/worktrees\n" +
    "  clobber worktrees set-default --worktree-root /mnt/fast-ssd/worktrees\n",
  subcommands: SUBCOMMANDS,
  async run(ctx) {
    const [sub, ...rest] = ctx.args;
    if (sub === undefined) {
      throw new CliUsageError("worktrees: missing subcommand (try `worktrees set-default`)");
    }
    if (!isSubcommand(sub)) {
      throw new CliUsageError(`worktrees: unknown subcommand: ${sub}`);
    }
    if (sub === "set") return runSet(ctx, rest);
    if (sub === "set-agent") return runSetAgent(ctx, rest);
    return runSetDefault(ctx, rest);
  },
};
