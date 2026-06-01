import type { CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

// #413 — `roles delete <name|id> [--force]`: remove a forked role + its
// fork-branch + config refs. The server enforces the guards (live sessions are
// a hard stop even with --force; persistent / spawned-agents yield to --force).

interface DeleteResponse {
  readonly role_id: string;
  readonly name: string;
  readonly deleted_branch: string | null;
}

export async function runDelete(
  ctx: CommandContext,
  json: boolean,
  rest: readonly string[],
): Promise<number> {
  let force = false;
  const positionals: string[] = [];
  for (const arg of rest) {
    if (arg === "--force") force = true;
    else positionals.push(arg);
  }
  const [target, ...extra] = positionals;
  if (target === undefined) {
    throw new CliUsageError(
      "roles delete: missing role name or id (usage: `roles delete <name|id> [--force]`)",
    );
  }
  if (extra.length > 0) {
    throw new CliUsageError(`roles delete: unexpected arguments: ${extra.join(" ")}`);
  }

  const result = await request<DeleteResponse>(ctx.env, {
    method: "DELETE",
    path: `/agent/roles/${encodeURIComponent(target)}${force ? "?force=true" : ""}`,
  });

  if (json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const branch = result.deleted_branch === null ? "" : ` (branch ${result.deleted_branch})`;
  ctx.stdout.write(`deleted role ${result.name}${branch}\n`);
  return 0;
}
