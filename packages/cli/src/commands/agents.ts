import type { Command, Subcommand } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface AgentEntry {
  readonly session_id: string;
  readonly agent_id: string;
  readonly role: { readonly id: string; readonly name: string };
  readonly label?: string;
  readonly pid: number;
  readonly state: "busy" | "idle";
  readonly started_at: number;
  readonly is_caller: boolean;
}

interface AgentsListResponse {
  readonly agents: readonly AgentEntry[];
}

const SUBCOMMANDS: readonly Subcommand[] = [
  { name: "list", capability: "agents" },
];

function isSubcommand(name: string): boolean {
  return SUBCOMMANDS.some((s) => s.name === name);
}

const AGENTS_USAGE = `usage: clobber agents <list>

List or operate on live agents in the current workspace.

Subcommands:
  list   Print every live agent (session_id, role, label, state, pid) as JSON.

Flags:
  (no flags)

Example:
  clobber agents list

Skill: see manager:agents for triage and load-balancing patterns.`;

export const agentsCommand: Command = {
  name: "agents",
  summary: "List or operate on live agents in the current workspace.",
  usage: AGENTS_USAGE,
  subcommands: SUBCOMMANDS,
  async run(ctx) {
    const [sub, ...rest] = ctx.args;
    if (sub === undefined) {
      throw new CliUsageError("agents: missing subcommand (try `agents list`)");
    }
    if (!isSubcommand(sub)) {
      throw new CliUsageError(`agents: unknown subcommand: ${sub}`);
    }
    if (rest.length > 0) {
      throw new CliUsageError(`agents ${sub}: unexpected arguments: ${rest.join(" ")}`);
    }
    const result = await request<AgentsListResponse>(ctx.env, {
      method: "GET",
      path: "/agent/agents",
    });
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  },
};
