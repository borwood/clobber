import type { CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface AgentMe {
  readonly workspace_id: string;
}

interface ModuleDetail {
  readonly name: string;
  readonly source: string;
  readonly definition:
    | { kind: "static"; text: string }
    | { kind: "dynamic"; provider: { kind: string; command?: string; args?: string[]; url?: string; headers?: Record<string, string> } };
}

export async function runShow(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  const nonFlags = rest.filter((a) => a !== "--json");
  const json = rest.includes("--json");
  const extra = nonFlags.filter((a) => !a.startsWith("-"));
  const name = extra[0];

  if (name === undefined) {
    throw new CliUsageError("prompt-modules show: missing module name");
  }
  if (extra.length > 1) {
    throw new CliUsageError(
      `prompt-modules show: unexpected arguments: ${extra.slice(1).join(" ")}`,
    );
  }

  const me = await request<AgentMe>(ctx.env, { method: "GET", path: "/agent/me" });
  const mod = await request<ModuleDetail>(ctx.env, {
    method: "GET",
    path: `/workspaces/${me.workspace_id}/prompt-modules/${encodeURIComponent(name)}`,
  });

  if (json) {
    ctx.stdout.write(`${JSON.stringify(mod, null, 2)}\n`);
    return 0;
  }

  ctx.stdout.write(`name:   ${mod.name}\n`);
  ctx.stdout.write(`source: ${mod.source}\n`);
  ctx.stdout.write(`---\n`);

  const def = mod.definition;
  if (def.kind === "static") {
    ctx.stdout.write(`kind: static\ntext:\n${def.text}\n`);
  } else {
    const prov = def.provider;
    // Surface dynamic providers prominently — they run code at compose time.
    ctx.stdout.write(`kind: dynamic  (runs at compose time)\nprovider: ${prov.kind}\n`);
    if (prov.kind === "exec") {
      ctx.stdout.write(`  command: ${prov.command ?? ""}\n`);
      if (prov.args !== undefined && prov.args.length > 0) {
        ctx.stdout.write(`  args: ${prov.args.join(" ")}\n`);
      }
    } else if (prov.kind === "http") {
      ctx.stdout.write(`  url: ${prov.url ?? ""}\n`);
    }
  }

  return 0;
}
