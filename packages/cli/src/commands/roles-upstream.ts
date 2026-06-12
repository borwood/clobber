import type { CommandContext } from "../commands.ts";
import { request } from "../http.ts";
import { CliUsageError } from "../usage-error.ts";

// #401 step-1 — the upstream read verbs: fetch / diff @{upstream} / log @{upstream}..
// #637 AC3 — log with no range returns branch changelog (entries[]); with @{upstream}..
// returns legacy upstream-ahead list. All git work is server-side.

interface FetchResponse {
  readonly fetched: boolean;
}

interface UpstreamDiffResponse {
  readonly diff: string;
}

interface UpstreamLogResponse {
  readonly log: string;
}

interface BranchChangelogResponse {
  readonly entries: ReadonlyArray<{
    sha: string;
    message: string;
    provenance: { label: string; role: string; pin: string; sessionId: string } | null;
  }>;
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

// `roles log <role> [@{upstream}..]` — branch changelog (no range) or
// upstream-ahead list (with @{upstream}..).
export async function runLogUpstream(
  ctx: CommandContext,
  json: boolean,
  rest: readonly string[],
): Promise<number> {
  const [roleName, ...restArgs] = rest;
  if (roleName === undefined) {
    throw new CliUsageError(
      "roles log: missing role name (usage: `roles log <name|id> [@{upstream}..]`)",
    );
  }

  let range: string | undefined;
  const remaining = [...restArgs];
  if (remaining.length > 0 && (remaining[0] === "@{upstream}.." || remaining[0] === "@{upstream}")) {
    range = remaining.shift();
  }
  if (remaining.length > 0) {
    throw new CliUsageError(`roles log: unexpected arguments: ${remaining.join(" ")}`);
  }

  if (range === undefined) {
    const result = await request<BranchChangelogResponse>(ctx.env, {
      method: "GET",
      path: `/agent/roles/${encodeURIComponent(roleName)}/upstream/log`,
    });
    if (json) {
      ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (result.entries.length === 0) {
      ctx.stdout.write("(no commits on branch)\n");
      return 0;
    }
    for (const entry of result.entries) {
      const prov = entry.provenance !== null ? ` [${entry.provenance.label}]` : "";
      ctx.stdout.write(`${entry.sha.slice(0, 8)} ${entry.message}${prov}\n`);
    }
    return 0;
  }

  const result = await request<UpstreamLogResponse>(ctx.env, {
    method: "GET",
    path: `/agent/roles/${encodeURIComponent(roleName)}/upstream/log?range=${encodeURIComponent(range)}`,
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
