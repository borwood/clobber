import type { CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

// #401 step-1 — the upstream read verbs: fetch / diff @{upstream} / log @{upstream}..
// All git work is server-side; these are thin HTTP wrappers over the new routes.

interface FetchResponse {
  readonly fetched: boolean;
}

interface UpstreamDiffResponse {
  readonly diff: string;
}

interface UpstreamLogResponse {
  readonly log: string;
}

// `roles fetch` — refresh upstream remote-tracking refs in the workspace clone.
export async function runFetch(ctx: CommandContext, json: boolean): Promise<number> {
  const result = await request<FetchResponse>(ctx.env, {
    method: "POST",
    path: "/agent/roles/fetch",
  });
  if (json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  ctx.stdout.write(result.fetched ? "fetched upstream\n" : "fetch failed\n");
  return 0;
}

// `roles diff <role> @{upstream}` — line-level diff of local pin vs upstream default.
export async function runDiffUpstream(
  ctx: CommandContext,
  json: boolean,
  roleName: string,
): Promise<number> {
  const result = await request<UpstreamDiffResponse>(ctx.env, {
    method: "GET",
    path: `/agent/roles/${encodeURIComponent(roleName)}/upstream/diff`,
  });
  if (json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const content = result.diff.length > 0 ? result.diff : "(no differences from upstream)\n";
  ctx.stdout.write(content);
  return 0;
}

// `roles log <role> @{upstream}..` — commits on upstream not yet in local pin.
export async function runLogUpstream(
  ctx: CommandContext,
  json: boolean,
  rest: readonly string[],
): Promise<number> {
  const [roleName, range, ...extra] = rest;
  if (roleName === undefined) {
    throw new CliUsageError(
      "roles log: missing role name (usage: `roles log <name|id> @{upstream}..`)",
    );
  }
  if (range !== "@{upstream}.." && range !== "@{upstream}") {
    throw new CliUsageError(
      `roles log: expected @{upstream}.. or @{upstream}, got: ${range ?? "(nothing)"}`,
    );
  }
  if (extra.length > 0) {
    throw new CliUsageError(`roles log: unexpected arguments: ${extra.join(" ")}`);
  }
  const result = await request<UpstreamLogResponse>(ctx.env, {
    method: "GET",
    path: `/agent/roles/${encodeURIComponent(roleName)}/upstream/log`,
  });
  if (json) {
    ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const content =
    result.log.trim().length > 0 ? `${result.log.trimEnd()}\n` : "(no commits ahead on upstream)\n";
  ctx.stdout.write(content);
  return 0;
}
