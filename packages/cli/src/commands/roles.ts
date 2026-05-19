import {
  RoleDetailResponseSchema,
  RolesListResponseSchema,
  type RoleDetailResponse,
  type RoleListEntry,
  type RoleTrigger,
} from "@clobber/shared";
import type { Command, CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";
import { runEdit } from "./roles-edit.ts";

const SUBCOMMANDS = ["list", "show", "fork", "edit", "ceiling"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(name: string): name is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(name);
}

function takeJsonFlag(args: readonly string[]): {
  readonly json: boolean;
  readonly rest: readonly string[];
} {
  const rest: string[] = [];
  let json = false;
  for (const a of args) {
    if (a === "--json") {
      json = true;
      continue;
    }
    rest.push(a);
  }
  return { json, rest };
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function renderListTable(roles: readonly RoleListEntry[]): string {
  if (roles.length === 0) return "(no roles)\n";
  const headers = ["NAME", "PERSISTENT", "VERSION", "TOOLS"];
  const rows = roles.map((r) => [
    r.name,
    r.persistent ? "yes" : "no",
    `v${r.version}`,
    r.allowed_tools === undefined ? "" : r.allowed_tools.join(","),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]!.length)),
  );
  const lines = [
    headers.map((h, i) => pad(h, widths[i]!)).join("  "),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map((row) => row.map((c, i) => pad(c, widths[i]!)).join("  ")),
  ];
  return `${lines.join("\n")}\n`;
}

async function runList(ctx: CommandContext, json: boolean): Promise<number> {
  const raw = await request<unknown>(ctx.env, {
    method: "GET",
    path: "/agent/roles",
  });
  const result = RolesListResponseSchema.parse(raw);
  if (json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  ctx.stdout.write(renderListTable(result.roles));
  return 0;
}

function formatTrigger(t: RoleTrigger): string {
  if (t.kind === "cron") return `cron — \`${t.expr}\``;
  if (t.kind === "file-watch") return `file-watch — \`${t.glob}\``;
  if (t.kind === "webhook") return `webhook — \`${t.path}\``;
  return t.repo === undefined
    ? "issue-assigned"
    : `issue-assigned — repo \`${t.repo}\``;
}

function renderShowMarkdown(role: RoleDetailResponse): string {
  const lines: string[] = [];
  lines.push(`# ${role.name}`);
  if (role.description !== undefined) {
    lines.push("");
    lines.push(role.description);
  }
  lines.push("");
  lines.push(`- id: \`${role.id}\``);
  lines.push(`- persistent: ${role.persistent ? "yes" : "no"}`);
  lines.push(`- current version: v${role.current_version.version}`);
  lines.push(
    `- allowed tools: ${
      role.current_version.allowed_tools.length === 0
        ? "(none)"
        : role.current_version.allowed_tools.join(", ")
    }`,
  );
  lines.push("");
  lines.push(`## System prompt (version ${role.current_version.version})`);
  lines.push("");
  lines.push(role.current_version.system_prompt.trimEnd());
  lines.push("");
  lines.push("## Triggers");
  if (role.current_version.triggers.length === 0) {
    lines.push("(none)");
  } else {
    for (const t of role.current_version.triggers) {
      lines.push(`- ${formatTrigger(t)}`);
    }
  }
  lines.push("");
  lines.push("## Skills");
  if (role.current_version.skills.length === 0) {
    lines.push("(none)");
  } else {
    for (const skill of role.current_version.skills) {
      lines.push("");
      lines.push(`### ${skill.name}`);
      lines.push("");
      lines.push(skill.body.trimEnd());
    }
  }
  lines.push("");
  lines.push("## Version history");
  for (const v of role.version_history) {
    const created = new Date(v.created_at).toISOString();
    lines.push(`- v${v.version} — ${v.id} (${created})`);
  }
  lines.push("");
  return lines.join("\n");
}

interface ForkResponse {
  readonly role_id: string;
  readonly version_id: string;
  readonly version: number;
}

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
  const result = await request<ForkResponse>(ctx.env, {
    method: "POST",
    path: `/agent/roles/${encodeURIComponent(source)}/fork`,
    body: { new_name: newName },
  });
  if (json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  ctx.stdout.write(
    `forked ${source} -> ${newName} (id: ${result.role_id}, version: v${result.version})\n`,
  );
  return 0;
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
  ctx.stdout.write(
    `set ceiling on ${target} -> ${result.max_concurrent}\n`,
  );
  return 0;
}

async function runShow(
  ctx: CommandContext,
  json: boolean,
  rest: readonly string[],
): Promise<number> {
  const [target, ...extra] = rest;
  if (target === undefined) {
    throw new CliUsageError(
      "roles show: missing role name or id (usage: `roles show <name|id>`)",
    );
  }
  if (extra.length > 0) {
    throw new CliUsageError(
      `roles show: unexpected arguments: ${extra.join(" ")}`,
    );
  }
  const raw = await request<unknown>(ctx.env, {
    method: "GET",
    path: `/agent/roles/${encodeURIComponent(target)}`,
  });
  const result = RoleDetailResponseSchema.parse(raw);
  if (json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  ctx.stdout.write(renderShowMarkdown(result));
  return 0;
}

export const rolesCommand: Command = {
  name: "roles",
  summary: "List or inspect roles available in the current workspace.",
  usage:
    "usage: clobber roles <list|show|fork|edit|ceiling> [args...]\n\n" +
    "Subcommands:\n" +
    "  roles list [--json]                          List workspace roles with version metadata.\n" +
    "  roles show <name|id> [--json]                Show full role + current version + history.\n" +
    "  roles fork <source-name|id> <new-name> [--json]  Fork a role into a new editable workspace role.\n" +
    "  roles edit <name|id> [flags] [--json]        Patch a role; system_prompt/skills/allowed_tools/triggers bump version, description does not.\n" +
    "  roles ceiling <name|id> <max> [--json]       Set the spawn ceiling for this role in this workspace.\n\n" +
    "Flags (roles edit):\n" +
    "  --system-prompt-file FILE      Replace system prompt from a file.\n" +
    "  --system-prompt -              Replace system prompt from stdin.\n" +
    "  --allowed-tools tool1,tool2    Replace the allowed tool list.\n" +
    "  --add-skill name=FILE          Add (or replace) a skill (repeatable).\n" +
    "  --remove-skill name            Remove a skill by name (repeatable).\n" +
    "  --description TEXT             Replace the role description (does not bump version).\n" +
    "  --description-file FILE        Replace the role description from a file.\n" +
    "  --triggers JSON                Replace triggers (JSON array of trigger objects, persistent roles only).\n" +
    "  --triggers-file FILE           Replace triggers from a JSON file.\n\n" +
    "Example:\n" +
    "  clobber roles fork worker my-worker\n" +
    "  clobber roles edit my-worker --description \"My experimental worker\"\n\n" +
    "Skill: see manager:roles for fork/edit/version patterns.\n",
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
    if (sub === "ceiling") {
      return runCeiling(ctx, json, subArgs);
    }
    return runShow(ctx, json, subArgs);
  },
};
