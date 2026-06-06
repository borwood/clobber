import type { FastifyInstance } from "fastify";
import { resolveRoleByIdOrName } from "../resolve-role.ts";
import { resolveRoleRepoDir } from "../resolve-role-repo-dir.ts";
import {
  diffRoleVsUpstream,
  fetchUpstream,
  logUpstreamAhead,
} from "../role-upstream-diff.ts";
import { withAgentAuth } from "./_with-agent-auth.ts";
import type { AgentRolesRouteDeps } from "./agent-roles.ts";

// #401 step-1 — upstream read verbs: fetch / diff @{upstream} / log @{upstream}..
// The workspace clone carries an `upstream` remote; these routes expose the
// engine-drift read surface. All git work is server-side (the repo lives here).

export function registerAgentRoleUpstreamRoutes(
  app: FastifyInstance,
  deps: AgentRolesRouteDeps,
): void {
  // Fetch upstream remote in the workspace's role repo — refreshes
  // upstream/*-default remote-tracking refs. Read-only: no pin-sync.
  app.post(
    "/agent/roles/fetch",
    withAgentAuth("roles.fetch", deps, async (_request, _reply, { session }) => {
      const { workspaceRepos } = deps;
      if (workspaceRepos === undefined) {
        return { error: "upstream read verbs require git-as-truth (role repo not configured)" };
      }
      const repoDir = workspaceRepos.dirFor(session.workspace_id);
      fetchUpstream(repoDir);
      return { fetched: true };
    }),
  );

  // Diff the role's local pin vs its resolved upstream default (line-level hunks).
  app.get<{ Params: { idOrName: string } }>(
    "/agent/roles/:idOrName/upstream/diff",
    withAgentAuth<{ Params: { idOrName: string } }>(
      "roles.upstream.diff",
      deps,
      async (request, reply, { session }) => {
        const { idOrName } = request.params;
        const role = resolveRoleByIdOrName(deps.roles, idOrName, session.workspace_id);
        if (role === null || role.workspace_id !== session.workspace_id) {
          reply.code(404);
          return { error: `role not found: ${idOrName}` };
        }
        if (role.current_commit === undefined) {
          reply.code(422);
          return { error: `role ${role.name} has no commit pin` };
        }
        const { roleForks, workspaceRepos } = deps;
        if (roleForks === undefined || workspaceRepos === undefined) {
          reply.code(422);
          return { error: "upstream read verbs require git-as-truth (role repo not configured)" };
        }
        const repoDir = resolveRoleRepoDir(role, deps);
        if (repoDir === undefined) {
          reply.code(422);
          return { error: `no role repo resolves for role ${role.name}` };
        }
        try {
          const diff = diffRoleVsUpstream(repoDir, role, roleForks);
          return { diff };
        } catch (err) {
          reply.code(422);
          return { error: (err as Error).message };
        }
      },
    ),
  );

  // List commits on the upstream default not yet in the local pin — "what
  // changed upstream since my fork". Returns --oneline log text.
  app.get<{ Params: { idOrName: string } }>(
    "/agent/roles/:idOrName/upstream/log",
    withAgentAuth<{ Params: { idOrName: string } }>(
      "roles.upstream.log",
      deps,
      async (request, reply, { session }) => {
        const { idOrName } = request.params;
        const role = resolveRoleByIdOrName(deps.roles, idOrName, session.workspace_id);
        if (role === null || role.workspace_id !== session.workspace_id) {
          reply.code(404);
          return { error: `role not found: ${idOrName}` };
        }
        if (role.current_commit === undefined) {
          reply.code(422);
          return { error: `role ${role.name} has no commit pin` };
        }
        const { roleForks, workspaceRepos } = deps;
        if (roleForks === undefined || workspaceRepos === undefined) {
          reply.code(422);
          return { error: "upstream read verbs require git-as-truth (role repo not configured)" };
        }
        const repoDir = resolveRoleRepoDir(role, deps);
        if (repoDir === undefined) {
          reply.code(422);
          return { error: `no role repo resolves for role ${role.name}` };
        }
        try {
          const log = logUpstreamAhead(repoDir, role, roleForks);
          return { log };
        } catch (err) {
          reply.code(422);
          return { error: (err as Error).message };
        }
      },
    ),
  );
}
