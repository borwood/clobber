import { AGENT_STATES, type AgentState } from "@clobber/shared";
import type { Command } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface ParsedArgs {
  readonly state: AgentState;
  readonly summary: string;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const stateArg = args[0];
  if (stateArg === undefined) {
    throw new CliUsageError(`missing state (one of: ${AGENT_STATES.join(", ")})`);
  }
  if (!isAgentState(stateArg)) {
    throw new CliUsageError(
      `unknown state: ${stateArg} (must be one of: ${AGENT_STATES.join(", ")})`,
    );
  }
  const summary = args[1];
  if (summary === undefined || summary.length === 0) {
    throw new CliUsageError("missing summary");
  }
  if (args.length > 2) {
    throw new CliUsageError(
      `unexpected extra arguments: ${args.slice(2).join(" ")}`,
    );
  }
  return { state: stateArg, summary };
}

function isAgentState(value: string): value is AgentState {
  return (AGENT_STATES as readonly string[]).includes(value);
}

export const statusCommand: Command = {
  name: "status",
  summary: "Post a structured status update for the current agent.",
  async run(ctx) {
    const parsed = parseArgs(ctx.args);
    await request<{ ok: true }>(ctx.env, {
      method: "POST",
      path: "/agent/status",
      body: { state: parsed.state, summary: parsed.summary },
    });
    return 0;
  },
};
