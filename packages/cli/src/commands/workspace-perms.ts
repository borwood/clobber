import type { CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

interface AgentMe {
  readonly workspace_id: string;
}

interface WorkspacePermsScope {
  readonly perms_scope: {
    readonly allow: readonly string[];
    readonly deny: readonly string[];
  };
}

interface ShowFlags {
  readonly outputJson: boolean;
}

interface SetFlags {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly outputJson: boolean;
}

function parseShowFlags(args: readonly string[]): ShowFlags {
  let outputJson = false;
  for (const arg of args) {
    if (arg === "--json") {
      outputJson = true;
      continue;
    }
    throw new CliUsageError(`workspace perms show: unknown argument: ${arg}`);
  }
  return { outputJson };
}

function parseSetFlags(args: readonly string[]): SetFlags {
  const allow: string[] = [];
  const deny: string[] = [];
  let outputJson = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--allow") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("-")) {
        throw new CliUsageError("workspace perms set: --allow requires a token");
      }
      allow.push(v);
      i += 1;
      continue;
    }
    if (arg === "--deny") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("-")) {
        throw new CliUsageError("workspace perms set: --deny requires a token (prefix with !)");
      }
      deny.push(v);
      i += 1;
      continue;
    }
    if (arg === "--json") {
      outputJson = true;
      continue;
    }
    throw new CliUsageError(`workspace perms set: unknown argument: ${arg}`);
  }

  if (allow.length === 0 && deny.length === 0) {
    throw new CliUsageError("workspace perms set: at least one --allow or --deny token required");
  }
  return { allow, deny, outputJson };
}

export async function runPermsShow(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  const flags = parseShowFlags(rest);
  const me = await request<AgentMe>(ctx.env, { method: "GET", path: "/agent/me" });
  const ws = await request<WorkspacePermsScope>(ctx.env, {
    method: "GET",
    path: `/workspaces/${me.workspace_id}`,
  });
  if (flags.outputJson) {
    ctx.stdout.write(`${JSON.stringify(ws.perms_scope, null, 2)}\n`);
  } else {
    ctx.stdout.write(`allow: ${ws.perms_scope.allow.join(", ") || "(none)"}\n`);
    ctx.stdout.write(`deny:  ${ws.perms_scope.deny.join(", ") || "(none)"}\n`);
  }
  return 0;
}

export async function runPermsSet(ctx: CommandContext, rest: readonly string[]): Promise<number> {
  const flags = parseSetFlags(rest);
  const me = await request<AgentMe>(ctx.env, { method: "GET", path: "/agent/me" });
  const result = await request<WorkspacePermsScope>(ctx.env, {
    method: "PATCH",
    path: `/workspaces/${me.workspace_id}`,
    body: { perms_scope: { allow: flags.allow, deny: flags.deny } },
  });
  if (flags.outputJson) {
    ctx.stdout.write(`${JSON.stringify(result.perms_scope, null, 2)}\n`);
  } else {
    ctx.stdout.write("workspace perms updated\n");
  }
  return 0;
}
