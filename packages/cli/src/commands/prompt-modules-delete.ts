import type { CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface AgentMe {
  readonly workspace_id: string;
}

interface DeleteResult {
  readonly name: string;
  readonly deleted: boolean;
}

export async function runDelete(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  const nonFlags = rest.filter((a) => a !== "--force" && a !== "--json");
  const force = rest.includes("--force");
  const json = rest.includes("--json");
  const name = nonFlags[0];

  if (name === undefined) {
    throw new CliUsageError("prompt-modules delete: missing module name");
  }
  if (nonFlags.length > 1) {
    throw new CliUsageError(
      `prompt-modules delete: unexpected arguments: ${nonFlags.slice(1).join(" ")}`,
    );
  }

  const me = await request<AgentMe>(ctx.env, { method: "GET", path: "/agent/me" });
  const qs = force ? "?force=true" : "";
  const result = await request<DeleteResult>(ctx.env, {
    method: "DELETE",
    path: `/workspaces/${me.workspace_id}/prompt-modules/${encodeURIComponent(name)}${qs}`,
  });

  if (json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  ctx.stdout.write(`deleted ${result.name}\n`);
  return 0;
}
