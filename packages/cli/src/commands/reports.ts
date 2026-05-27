import type { Command, CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface ReportSummary {
  readonly session_id: string;
  readonly role: string;
  readonly label?: string;
  readonly state: string;
  readonly summary: string;
  readonly created_at: number;
}

interface ReportDetail extends ReportSummary {
  readonly report: {
    readonly well?: string;
    readonly badly?: string;
    readonly useful?: string;
    readonly free_text?: string;
  };
}

interface ParsedFlags {
  readonly json: boolean;
}

function parseFlags(args: readonly string[], verb: string): ParsedFlags {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new CliUsageError(`reports ${verb}: unknown flag: ${arg}`);
  }
  return { json };
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

function renderList(reports: readonly ReportSummary[]): string {
  const lines: string[] = [`# reports (${reports.length})`];
  for (const r of reports) {
    const label = r.label === undefined ? "" : ` "${r.label}"`;
    lines.push("");
    lines.push(`${r.session_id}  ${r.role}${label}  [${r.state}]  ${isoTime(r.created_at)}`);
    lines.push(`  ${r.summary}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderDetail(r: ReportDetail): string {
  const lines: string[] = [`# report ${r.session_id}`];
  lines.push(`role:  ${r.role}`);
  if (r.label !== undefined) lines.push(`label: ${r.label}`);
  lines.push(`state: ${r.state}`);
  lines.push(`when:  ${isoTime(r.created_at)}`);
  lines.push("");
  if (r.report.free_text !== undefined) {
    lines.push(r.report.free_text);
  } else {
    if (r.report.well !== undefined) lines.push(`well:   ${r.report.well}`);
    if (r.report.badly !== undefined) lines.push(`badly:  ${r.report.badly}`);
    if (r.report.useful !== undefined) lines.push(`useful: ${r.report.useful}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function runList(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  const flags = parseFlags(rest, "list");
  const result = await request<{ reports: ReportSummary[] }>(ctx.env, {
    method: "GET",
    path: "/agent/reports",
  });
  if (flags.json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    ctx.stdout.write(renderList(result.reports));
  }
  return 0;
}

async function runShow(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  const [sessionId, ...flagArgs] = rest;
  if (sessionId === undefined) {
    throw new CliUsageError("reports show: missing session id (usage: `reports show <session-id>`)");
  }
  const flags = parseFlags(flagArgs, "show");
  const result = await request<ReportDetail>(ctx.env, {
    method: "GET",
    path: `/agent/reports/${encodeURIComponent(sessionId)}`,
  });
  if (flags.json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    ctx.stdout.write(renderDetail(result));
  }
  return 0;
}

const REPORTS_USAGE = `usage: clobber reports list [--json]
       clobber reports show <session-id> [--json]

Read worker final reports for this workspace. Reports are the system of
record (agent_status_log, kind=final-report) — this is the manager's triage
read interface, the sibling of \`clobber transcript\`.

Subcommands:
  list                 Recent final reports: session id, role, label, state,
                       one-line summary, timestamp. Newest first.
  show <session-id>    The full structured well/badly/useful for one report.

Flags:
  --json               Emit raw JSON instead of formatted text.

Examples:
  clobber reports list
  clobber reports show 0b2f4e1a-...

Skill: see manager:reports for triage strategy (ticket vs wisdom-capture vs nothing).`;

export const reportsCommand: Command = {
  name: "reports",
  summary: "Read worker final reports for this workspace (manager triage interface).",
  usage: REPORTS_USAGE,
  subcommands: ["list", "show"],
  async run(ctx) {
    const [verb, ...rest] = ctx.args;
    if (verb === "list") return runList(ctx, rest);
    if (verb === "show") return runShow(ctx, rest);
    if (verb === undefined) {
      throw new CliUsageError("reports: missing subcommand (expected `list` or `show`)");
    }
    throw new CliUsageError(`reports: unknown subcommand: ${verb} (expected \`list\` or \`show\`)`);
  },
};
