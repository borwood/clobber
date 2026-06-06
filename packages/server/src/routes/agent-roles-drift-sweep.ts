import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { BootContext } from "@clobber/shared";
import type { RoleStore } from "../role-store.ts";
import type { ForkRef } from "../role-repo.ts";
import type { WorkspaceRoleRepos } from "../workspace-role-repos.ts";
import { logUpstreamAhead } from "../role-upstream-diff.ts";

// #401 step-2 — drift-sweep route. Called by the roles-drift-sweep prompt-module's
// http provider at every persistent-agent wake. Accepts BootContext (workspace_id)
// as the POST body — no agent session token (server-internal call from the compose
// path). Returns plain text: terse on zero-drift (dilution guard), expanded on drift.

export interface AgentRolesDriftSweepRouteDeps {
  readonly roles: RoleStore;
  readonly roleForks?: ReadonlyMap<string, ForkRef>;
  readonly workspaceRepos?: WorkspaceRoleRepos;
}

export function registerAgentRolesDriftSweepRoute(
  app: FastifyInstance,
  deps: AgentRolesDriftSweepRouteDeps,
): void {
  app.post("/agent/roles/drift-sweep", async (request, reply) => {
    reply.header("content-type", "text/plain");

    const { roleForks, workspaceRepos } = deps;
    if (roleForks === undefined || workspaceRepos === undefined) {
      return "Role drift check unavailable (role repo not configured).";
    }

    const body = request.body as BootContext;
    const repoDir = workspaceRepos.dirFor(body.workspace_id);
    const roles = deps.roles.listForWorkspace(body.workspace_id);

    interface RoleResult {
      readonly name: string;
      readonly aheadCount: number | null;
      readonly note: string | null;
    }

    const results: RoleResult[] = [];
    for (const role of roles) {
      if (role.current_commit === undefined) {
        results.push({ name: role.name, aheadCount: null, note: "no commit pin" });
        continue;
      }
      try {
        const log = logUpstreamAhead(repoDir, role, roleForks);
        const lines = log.trim().split("\n").filter((l) => l.length > 0);
        results.push({ name: role.name, aheadCount: lines.length, note: null });
      } catch (err) {
        results.push({ name: role.name, aheadCount: null, note: (err as Error).message });
      }
    }

    const staleness = fetchedAgoText(repoDir);
    const drifted = results.filter((r) => r.aheadCount !== null && r.aheadCount > 0);
    const inSyncCount = results.filter((r) => r.aheadCount === 0).length;

    if (drifted.length === 0) {
      return `[Role drift] ${inSyncCount} role${inSyncCount === 1 ? "" : "s"} in sync (upstream refs fetched ${staleness}).`;
    }

    const lines: string[] = [
      `[Role drift — upstream refs fetched ${staleness}; run \`clobber roles fetch\` to refresh]`,
      "",
    ];
    for (const r of drifted) {
      const count = r.aheadCount!;
      lines.push(
        `${r.name}: ${count} commit${count === 1 ? "" : "s"} ahead — \`clobber roles log ${r.name} @{upstream}\``,
      );
    }
    for (const r of results.filter((r) => r.aheadCount === null)) {
      lines.push(`${r.name}: ${r.note}`);
    }
    if (inSyncCount > 0) {
      lines.push(`${inSyncCount} role${inSyncCount === 1 ? "" : "s"} in sync.`);
    }
    return lines.join("\n");
  });
}

function fetchedAgoText(repoDir: string): string {
  const fetchHead = join(repoDir, ".git", "FETCH_HEAD");
  if (!existsSync(fetchHead)) return "run `clobber roles fetch` to populate upstream refs";
  const ageMs = Date.now() - statSync(fetchHead).mtimeMs;
  const ageMin = Math.round(ageMs / 60_000);
  if (ageMin < 60) return `~${Math.max(0, ageMin)} min ago`;
  const ageHours = Math.round(ageMin / 60);
  if (ageHours < 48) return `~${ageHours} h ago`;
  return `~${Math.round(ageHours / 24)} d ago`;
}
