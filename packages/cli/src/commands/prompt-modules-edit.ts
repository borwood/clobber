import type { CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";
import { parseProviderFlags, readStdinText } from "./_prompt-modules-flags.ts";

interface AgentMe {
  readonly workspace_id: string;
}

interface EditResult {
  readonly name: string;
  readonly source: string;
  readonly shadowed_default: boolean;
}

export async function runEdit(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  const [name, ...flagArgs] = rest;
  if (name === undefined) {
    throw new CliUsageError("prompt-modules edit: missing module name");
  }

  const parsed = parseProviderFlags("edit", flagArgs);
  let definition: unknown;

  if (parsed.readFromStdin) {
    const text = await readStdinText(ctx.stdin);
    definition = { kind: "static", text };
  } else {
    definition = parsed.definition;
  }

  const me = await request<AgentMe>(ctx.env, { method: "GET", path: "/agent/me" });
  const result = await request<EditResult>(ctx.env, {
    method: "PUT",
    path: `/workspaces/${me.workspace_id}/prompt-modules/${encodeURIComponent(name)}`,
    body: { definition },
  });

  if (parsed.json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (result.shadowed_default) {
    ctx.stdout.write(`now shadowing the shipped default '${result.name}'\n`);
  }
  ctx.stdout.write(`edited ${result.name}  [${result.source}]\n`);
  return 0;
}
