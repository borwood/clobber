import { AGENT_STATES, type AgentState } from "@clobber/shared";
import type { Command } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface ParsedArgs {
  readonly state: AgentState;
  readonly summary: string;
}

export function parseStatusArgs(args: readonly string[]): ParsedArgs {
  const stateArg = args[0];
  if (stateArg === undefined) {
    throw new CliUsageError(`missing state (one of: ${AGENT_STATES.join(", ")})`);
  }
  if (!isAgentState(stateArg)) {
    throw new CliUsageError(
      `unknown state: ${stateArg} (must be one of: ${AGENT_STATES.join(", ")})`,
    );
  }

  let positionalSummary: string | undefined;
  let flagSummary: string | undefined;
  for (let i = 1; i < args.length; i += 1) {
    const tok = args[i]!;
    if (tok === "-m" || tok === "--message") {
      const value = args[i + 1];
      if (value === undefined || value.length === 0) {
        throw new CliUsageError("-m requires a value");
      }
      flagSummary = value;
      i += 1;
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      throw new CliUsageError(`status: unknown flag: ${tok}`);
    }
    if (positionalSummary !== undefined) {
      throw new CliUsageError(
        `unexpected extra arguments: ${args.slice(i).join(" ")}`,
      );
    }
    positionalSummary = tok;
  }

  if (positionalSummary !== undefined && flagSummary !== undefined) {
    throw new CliUsageError(
      "status: positional summary and -m both provided; pick one",
    );
  }
  const summary = flagSummary ?? positionalSummary;
  if (summary === undefined || summary.length === 0) {
    throw new CliUsageError("missing summary");
  }
  return { state: stateArg, summary };
}

function isAgentState(value: string): value is AgentState {
  return (AGENT_STATES as readonly string[]).includes(value);
}

const STATUS_USAGE = `usage: clobber status <state> <summary>

Post a structured status update for the current agent so the workspace
board reflects what you're doing right now.

Positional:
  <state>    One of: ${AGENT_STATES.join(", ")}.
  <summary>  One-line description of what you're doing (or use -m).

Flags:
  -m, --message <text>   Alternative to the positional <summary>; useful
                         when the summary contains shell-tricky chars.

Examples:
  clobber status working "drafting the migration for #34"
  clobber status working -m "drafting the migration for #34"

Skill: see manager:status / worker:status for cadence and tone guidance.`;

export const statusCommand: Command = {
  name: "status",
  summary: "Post a structured status update for the current agent.",
  usage: STATUS_USAGE,
  async run(ctx) {
    const parsed = parseStatusArgs(ctx.args);
    await request<{ ok: true }>(ctx.env, {
      method: "POST",
      path: "/agent/status",
      body: { state: parsed.state, summary: parsed.summary },
    });
    return 0;
  },
};
