import type { CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";
import { runDiffUpstream } from "./roles-upstream.ts";

// #216 — the working-copy verbs: edit a role like code. `checkout` materializes
// the role's branch tip into the desk; you edit the files with normal tools;
// `diff`/`status` inspect; `commit` serializes them back onto the branch and
// advances the pin (no new version row — closes #396); `discard` resets.

interface CheckoutResponse {
  readonly role_id: string;
  readonly branch: string;
  readonly base_sha: string;
  readonly checkout_dir: string;
}

interface FileChange {
  readonly path: string;
  readonly status: string;
}

interface StatusResponse {
  readonly open: boolean;
  readonly role_name?: string;
  readonly branch?: string;
  readonly base_sha?: string;
  readonly stale?: boolean;
  readonly changed?: readonly FileChange[];
}

interface CommitResponse {
  readonly role_id: string;
  readonly branch: string;
  readonly sha: string;
  readonly description: string;
}

interface BranchResponse {
  readonly role_id: string;
  readonly branch: string;
  readonly sha: string;
}

function emit(ctx: CommandContext, json: boolean, value: unknown, human: string): number {
  ctx.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : human);
  return 0;
}

function renderChanges(changed: readonly FileChange[]): string {
  if (changed.length === 0) return "(no changes)\n";
  return `${changed.map((c) => `  ${c.status.padEnd(9)}${c.path}`).join("\n")}\n`;
}

export async function runCheckout(
  ctx: CommandContext,
  json: boolean,
  rest: readonly string[],
): Promise<number> {
  if (rest[0] === "-b") {
    return runCheckoutBranch(ctx, json, rest.slice(1));
  }
  const [target, ...extra] = rest;
  if (target === undefined) {
    throw new CliUsageError("roles checkout: missing role name or id (usage: `roles checkout <name|id>`)");
  }
  if (extra.length > 0) {
    throw new CliUsageError(`roles checkout: unexpected arguments: ${extra.join(" ")}`);
  }
  const result = await request<CheckoutResponse>(ctx.env, {
    method: "POST",
    path: `/agent/roles/${encodeURIComponent(target)}/checkout`,
  });
  return emit(
    ctx,
    json,
    result,
    `checked out ${target} -> ${result.checkout_dir}\nedit the files, then \`clobber roles commit\` (or \`roles discard\`).\n`,
  );
}

// `roles checkout -b <new-name> --from <source>` — create/fork a role as a fresh
// git branch off the source tip (commit-pinned, no version row). `roles fork`
// is a thin alias that calls the same path.
async function runCheckoutBranch(
  ctx: CommandContext,
  json: boolean,
  rest: readonly string[],
): Promise<number> {
  let newName: string | undefined;
  let from: string | undefined;
  const args = [...rest];
  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--from") {
      from = args.shift();
      if (from === undefined) {
        throw new CliUsageError("roles checkout -b: --from requires a source name or id");
      }
    } else if (newName === undefined) {
      newName = arg;
    } else {
      throw new CliUsageError(`roles checkout -b: unexpected argument: ${arg}`);
    }
  }
  if (newName === undefined) {
    throw new CliUsageError(
      "roles checkout -b: missing <new-name> (usage: `roles checkout -b <new-name> --from <source>`)",
    );
  }
  if (from === undefined) {
    throw new CliUsageError(
      "roles checkout -b: missing --from <source> (usage: `roles checkout -b <new-name> --from <source>`)",
    );
  }
  return forkRoleBranch(ctx, json, from, newName);
}

// The shared create-via-git request behind both `checkout -b` and `fork`.
export async function forkRoleBranch(
  ctx: CommandContext,
  json: boolean,
  source: string,
  newName: string,
): Promise<number> {
  const result = await request<BranchResponse>(ctx.env, {
    method: "POST",
    path: `/agent/roles/${encodeURIComponent(source)}/fork`,
    body: { new_name: newName },
  });
  return emit(
    ctx,
    json,
    result,
    `created ${newName} (id: ${result.role_id}) -> ${result.branch}@${result.sha.slice(0, 8)} (forked from ${source}, no version row)\n`,
  );
}

export async function runCheckoutStatus(ctx: CommandContext, json: boolean): Promise<number> {
  const result = await request<StatusResponse>(ctx.env, { method: "GET", path: "/agent/role-checkout" });
  if (!result.open) return emit(ctx, json, result, "no checkout is open\n");
  const stale = result.stale === true ? " (STALE — branch advanced; commit needs --force)" : "";
  const human =
    `checkout: ${result.role_name} on ${result.branch}${stale}\n` +
    renderChanges(result.changed ?? []);
  return emit(ctx, json, result, human);
}

export async function runDiff(
  ctx: CommandContext,
  json: boolean,
  rest: readonly string[],
): Promise<number> {
  // `roles diff <role> @{upstream}` — upstream diff form (two positionals).
  const upstreamForm =
    rest.length >= 2 && (rest[1] === "@{upstream}" || (rest[1] === "--against" && rest[2] === "upstream"));
  if (upstreamForm) {
    return runDiffUpstream(ctx, json, rest[0]!);
  }
  let stat = false;
  for (const arg of rest) {
    if (arg === "--stat") {
      stat = true;
    } else {
      throw new CliUsageError(`roles diff: unexpected argument: ${arg}`);
    }
  }
  const result = await request<{ changed: FileChange[]; diff: string; stale: boolean }>(ctx.env, {
    method: "GET",
    path: "/agent/role-checkout/diff",
  });
  if (json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (stat) return emit(ctx, false, result, renderChanges(result.changed));
  const content = result.diff.length > 0 ? result.diff : "(no changes)\n";
  ctx.stdout.write(content);
  return 0;
}

export async function runCommit(
  ctx: CommandContext,
  json: boolean,
  rest: readonly string[],
): Promise<number> {
  let message: string | undefined;
  let force = false;
  const args = [...rest];
  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--force") {
      force = true;
    } else if (arg === "-m" || arg === "--message") {
      message = args.shift();
      if (message === undefined) {
        throw new CliUsageError(`roles commit: ${arg} requires a message`);
      }
    } else {
      throw new CliUsageError(`roles commit: unexpected argument: ${arg}`);
    }
  }
  if (message === undefined) {
    throw new CliUsageError("roles commit: -m <message> is required");
  }
  const body: { message: string; force?: boolean } = {
    message,
    ...(force ? { force: true } : {}),
  };
  const result = await request<CommitResponse>(ctx.env, {
    method: "POST",
    path: "/agent/role-checkout/commit",
    body,
  });
  return emit(
    ctx,
    json,
    result,
    `committed ${result.role_id} -> ${result.branch}@${result.sha.slice(0, 8)} (no new version row)\n`,
  );
}

export async function runDiscard(ctx: CommandContext, json: boolean): Promise<number> {
  const result = await request<{ discarded: boolean }>(ctx.env, {
    method: "POST",
    path: "/agent/role-checkout/discard",
  });
  return emit(ctx, json, result, result.discarded ? "checkout discarded\n" : "no checkout to discard\n");
}
