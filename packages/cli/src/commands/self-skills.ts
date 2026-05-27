import {
  SelfSkillsListResponseSchema,
  SelfSkillsMutationResponseSchema,
  type ManagerSkillPolicy,
  type RoleSkill,
  type SelfSkillsMutationResponse,
} from "@clobber/shared";
import type { Command, CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

const SUBCOMMANDS = ["list", "grant", "release"] as const;
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

function renderListTable(
  policy: ManagerSkillPolicy,
  granted: readonly RoleSkill[],
  catalog: readonly RoleSkill[],
): string {
  const grantedNames = new Set(granted.map((s) => s.name));
  const allowed = new Set(policy.allowed_skills);
  const seen = new Set<string>();
  const rows: Array<readonly [string, string, string]> = [];
  for (const s of [...granted, ...catalog]) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    const status = grantedNames.has(s.name) ? "granted" : "available";
    const policyMark = allowed.has(s.name) ? "yes" : "no";
    rows.push([s.name, status, policyMark] as const);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));

  const policyLine = `policy: allow_self_grant=${policy.allow_self_grant}; allowed_skills=[${policy.allowed_skills.join(", ")}]\n`;
  if (rows.length === 0) {
    return `${policyLine}(no skills)\n`;
  }
  const headers = ["NAME", "STATUS", "POLICY"] as const;
  const widths: [number, number, number] = [
    Math.max(headers[0].length, ...rows.map((r) => r[0].length)),
    Math.max(headers[1].length, ...rows.map((r) => r[1].length)),
    Math.max(headers[2].length, ...rows.map((r) => r[2].length)),
  ];
  const renderRow = (cells: readonly [string, string, string]): string =>
    `${pad(cells[0], widths[0])}  ${pad(cells[1], widths[1])}  ${pad(cells[2], widths[2])}`;
  const lines = [
    renderRow(headers),
    `${"-".repeat(widths[0])}  ${"-".repeat(widths[1])}  ${"-".repeat(widths[2])}`,
    ...rows.map(renderRow),
  ];
  return `${policyLine}${lines.join("\n")}\n`;
}

async function runList(ctx: CommandContext, json: boolean): Promise<number> {
  const raw = await request<unknown>(ctx.env, {
    method: "GET",
    path: "/agent/self-skills",
  });
  const result = SelfSkillsListResponseSchema.parse(raw);
  if (json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  ctx.stdout.write(renderListTable(result.policy, result.granted, result.catalog));
  return 0;
}

function renderMutation(
  ctx: CommandContext,
  result: SelfSkillsMutationResponse,
  verb: string,
  name: string,
  json: boolean,
): number {
  if (json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  ctx.stdout.write(
    `${verb} '${name}' (role ${result.role_id} → v${result.version}; ${result.granted.length} skills total)\n`,
  );
  return 0;
}

async function runGrant(
  ctx: CommandContext,
  name: string,
  json: boolean,
): Promise<number> {
  const raw = await request<unknown>(ctx.env, {
    method: "POST",
    path: "/agent/self-skills",
    body: { name },
  });
  const result = SelfSkillsMutationResponseSchema.parse(raw);
  return renderMutation(ctx, result, "granted", name, json);
}

async function runRelease(
  ctx: CommandContext,
  name: string,
  json: boolean,
): Promise<number> {
  const raw = await request<unknown>(ctx.env, {
    method: "DELETE",
    path: `/agent/self-skills/${encodeURIComponent(name)}`,
  });
  const result = SelfSkillsMutationResponseSchema.parse(raw);
  return renderMutation(ctx, result, "released", name, json);
}

function takeName(rest: readonly string[], verb: string): string {
  const name = rest[0];
  if (name === undefined || name.length === 0) {
    throw new CliUsageError(`self-skills ${verb} requires a skill name`);
  }
  if (rest.length > 1) {
    throw new CliUsageError(
      `self-skills ${verb} takes one skill name; got: ${rest.join(", ")}`,
    );
  }
  return name;
}

export const selfSkillsCommand: Command = {
  name: "self-skills",
  summary:
    "Inspect and mutate the calling persistent role's skill list within workspace policy.",
  usage:
    `usage: clobber self-skills <list|grant|release> [<name>] [--json]

  list                   Show policy, currently-granted skills, and the workspace catalog.
  grant <name>           Add a catalog skill to this role's skill list (policy-gated).
  release <name>         Remove a previously-granted skill from this role's skill list.

  --json                 Emit raw JSON instead of the table/summary.

Workspace catalog lives at <repo>/.clobber/skills/<name>/SKILL.md. Grants
are gated by the workspace's manager_skill_policy (PATCH /workspaces/:id).`,
  subcommands: SUBCOMMANDS,
  async run(ctx) {
    const { json, rest } = takeJsonFlag(ctx.args);
    const [sub, ...subRest] = rest;
    if (sub === undefined) {
      throw new CliUsageError("self-skills requires a subcommand");
    }
    if (!isSubcommand(sub)) {
      throw new CliUsageError(
        `unknown self-skills subcommand: ${sub} (expected one of ${SUBCOMMANDS.join(", ")})`,
      );
    }
    if (sub === "list") {
      if (subRest.length > 0) {
        throw new CliUsageError(
          `self-skills list takes no positional args; got: ${subRest.join(", ")}`,
        );
      }
      return runList(ctx, json);
    }
    if (sub === "grant") {
      const name = takeName(subRest, "grant");
      return runGrant(ctx, name, json);
    }
    const name = takeName(subRest, "release");
    return runRelease(ctx, name, json);
  },
};
