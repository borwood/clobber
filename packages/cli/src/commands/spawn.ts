import type { Command } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface SpawnResponse {
  readonly agent_id: string;
  readonly session_id: string;
  readonly pid: number;
}

interface ParsedArgs {
  readonly role: string;
  readonly prompt: string;
  readonly label: string;
}

export function parseSpawnArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  let prompt: string | undefined;
  let label: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === "--prompt" || tok === "-p") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliUsageError("--prompt requires a value");
      }
      prompt = value;
      i++;
    } else if (tok === "--label" || tok === "-l") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliUsageError("--label requires a value");
      }
      label = value;
      i++;
    } else if (tok.startsWith("--") || (tok.startsWith("-") && tok.length > 1)) {
      throw new CliUsageError(`unknown flag: ${tok}`);
    } else {
      positionals.push(tok);
    }
  }

  const role = positionals[0];
  if (role === undefined) {
    throw new CliUsageError("missing role positional argument");
  }
  if (positionals.length > 1) {
    throw new CliUsageError(`unexpected extra arguments: ${positionals.slice(1).join(" ")}`);
  }
  if (prompt === undefined) {
    throw new CliUsageError("--prompt is required");
  }
  if (label === undefined) {
    throw new CliUsageError(
      "--label is required (e.g. --label fix-flaky-test) — names a worker by what it's doing so the workspace board stays legible",
    );
  }

  return { role, prompt, label };
}

const SPAWN_USAGE = `usage: clobber spawn <role> --prompt <text> --label <slug>

Spawn a worker agent into the current workspace. The role must already
exist in this workspace (see \`clobber roles list\`). Prints the new
agent_id, session_id, and pid as JSON.

Flags:
  -p, --prompt <text>   Initial user prompt for the worker (required).
  -l, --label <slug>    Short slug naming what the worker is doing
                        (required, e.g. fix-flaky-test) so the workspace
                        board stays legible.

Example:
  clobber spawn worker --prompt "investigate flaky test in agents.test.ts" \\
                       --label fix-flaky-test

Skill: see manager:spawn for when to spawn vs. continue an existing session.`;

export const spawnCommand: Command = {
  name: "spawn",
  summary: "Spawn a worker agent into the current workspace.",
  usage: SPAWN_USAGE,
  async run(ctx) {
    const parsed = parseSpawnArgs(ctx.args);
    const body = {
      role: parsed.role,
      prompt: parsed.prompt,
      label: parsed.label,
    };
    const result = await request<SpawnResponse>(ctx.env, {
      method: "POST",
      path: "/agent/spawn",
      body,
    });
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  },
};
