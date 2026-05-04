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
  readonly label: string | undefined;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  let prompt: string | undefined;
  let label: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === "--prompt") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError("--prompt requires a value");
      }
      prompt = value;
      i++;
    } else if (tok === "--label") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError("--label requires a value");
      }
      label = value;
      i++;
    } else if (tok.startsWith("--")) {
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

  return { role, prompt, label };
}

export const spawnCommand: Command = {
  name: "spawn",
  summary: "Spawn a worker agent into the current workspace.",
  async run(ctx) {
    const parsed = parseArgs(ctx.args);
    const body: { role: string; prompt: string; label?: string } = {
      role: parsed.role,
      prompt: parsed.prompt,
      ...(parsed.label === undefined ? {} : { label: parsed.label }),
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
