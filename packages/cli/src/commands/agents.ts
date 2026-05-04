import type { Command } from "../commands.ts";
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

const SUBCOMMANDS = ["list"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(name: string): name is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(name);
}

export const agentsCommand: Command = {
  name: "agents",
  summary: "List or operate on live agents in the current workspace.",
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
