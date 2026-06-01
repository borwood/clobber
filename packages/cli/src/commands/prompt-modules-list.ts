import type { CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface AgentMe {
  readonly workspace_id: string;
}

interface CatalogEntry {
  readonly name: string;
  readonly kind: string;
  readonly source: string;
}

export async function runList(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  const json = rest.includes("--json");
  const extra = rest.filter((a) => a !== "--json");
  if (extra.length > 0) {
    throw new CliUsageError(`prompt-modules list: unexpected arguments: ${extra.join(" ")}`);
  }

  const me = await request<AgentMe>(ctx.env, { method: "GET", path: "/agent/me" });
  const entries = await request<CatalogEntry[]>(ctx.env, {
    method: "GET",
    path: `/workspaces/${me.workspace_id}/prompt-modules`,
  });

  if (json) {
    ctx.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return 0;
  }

  if (entries.length === 0) {
    ctx.stdout.write("(no prompt-modules)\n");
    return 0;
  }

  for (const entry of entries) {
    ctx.stdout.write(`${entry.name}  [${entry.kind}]  ${entry.source}\n`);
  }
  return 0;
}
