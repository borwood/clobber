import type { Command, CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface RoleListEntry {
  readonly id: string;
  readonly name: string;
  readonly persistent: boolean;
  readonly description?: string;
  readonly allowed_tools?: readonly string[];
  readonly current_version_id: string;
  readonly version: number;
  readonly created_at: number;
}

interface RolesListResponse {
  readonly roles: readonly RoleListEntry[];
}

interface RoleSkill {
  readonly name: string;
  readonly body: string;
}

interface RoleDetailResponse {
  readonly id: string;
  readonly name: string;
  readonly persistent: boolean;
  readonly description?: string;
  readonly current_version: {
    readonly id: string;
    readonly version: number;
    readonly system_prompt: string;
    readonly skills: readonly RoleSkill[];
    readonly allowed_tools: readonly string[];
    readonly hooks: unknown;
    readonly created_at: number;
  };
  readonly version_history: ReadonlyArray<{
    readonly id: string;
    readonly version: number;
    readonly created_at: number;
  }>;
}

const SUBCOMMANDS = ["list", "show", "fork"] as const;
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
  const result = await request<RolesListResponse>(ctx.env, {
    method: "GET",
    path: "/agent/roles",
  });
  if (json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  ctx.stdout.write(renderListTable(result.roles));
  return 0;
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
  const result = await request<RoleDetailResponse>(ctx.env, {
    method: "GET",
    path: `/agent/roles/${encodeURIComponent(target)}`,
  });
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
    "usage: clobber roles <list|show|fork> [args...]\n\n" +
    "  roles list [--json]                          List workspace roles with version metadata.\n" +
    "  roles show <name|id> [--json]                Show full role + current version + history.\n" +
    "  roles fork <source-name|id> <new-name> [--json]  Fork a role into a new editable workspace role.\n",
  async run(ctx) {
    const [sub, ...rest] = ctx.args;
    if (sub === undefined) {
      throw new CliUsageError("roles: missing subcommand (try `roles list`)");
    }
    if (!isSubcommand(sub)) {
      throw new CliUsageError(`roles: unknown subcommand: ${sub}`);
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
    return runShow(ctx, json, subArgs);
  },
};
