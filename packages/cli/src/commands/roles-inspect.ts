import {
  RoleDetailResponseSchema,
  RolesListResponseSchema,
  type RoleDetailResponse,
  type RoleListEntry,
  type RoleTrigger,
} from "@clobber/shared";
import type { CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";
import { pad } from "./roles-args.ts";

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

export async function runList(ctx: CommandContext, json: boolean): Promise<number> {
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
  if (t.kind === "workspace-open") {
    return t.debounce_ms === undefined
      ? "workspace-open"
      : `workspace-open — debounce \`${t.debounce_ms}ms\``;
  }
  if (t.kind === "session-ended") return "session-ended";
  if (t.kind === "worker-done") return "worker-done";
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
  lines.push("## Seeds");
  if (role.current_version.seed_refs.length === 0) {
    lines.push("(none)");
  } else {
    for (const ref of role.current_version.seed_refs) {
      lines.push(`- ${ref.name} — ${ref.enabled ? "enabled" : "disabled"}`);
    }
  }
  lines.push("");
  lines.push("## Wake-programs");
  if (role.current_version.wake_programs.length === 0) {
    lines.push("(none beyond the `idle` built-in)");
  } else {
    for (const p of role.current_version.wake_programs) {
      lines.push(`- ${p.name} — kick: ${p.user === null ? "(none)" : "yes"}`);
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

export async function runShow(
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
