import type { FastifyInstance } from "fastify";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { ROLE_NAME_RE, type RoleListEntry } from "@clobber/shared";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { RoleVersionStore } from "../role-version-store.ts";
import type { WorkspaceRoleStore } from "../workspace-role-store.ts";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { TriggerScheduler } from "../trigger-scheduler.ts";
import { forkRole } from "../fork-role.ts";
import {
  blockingViolations,
  deleteRole,
  evaluateDeleteGuards,
  gatherDeleteGuards,
} from "../delete-role.ts";
import { resolveRoleByIdOrName } from "../resolve-role.ts";
import { registerAgentRoleCheckoutRoutes } from "./agent-role-checkout.ts";
import { registerAgentRoleEditRoute } from "./agent-role-edit-route.ts";
import { withAgentAuth } from "./_with-agent-auth.ts";
import { buildDetail, buildListEntry } from "./_agent-roles-views.ts";

const ForkBodySchema = z.object({
  new_name: z.string().min(1).regex(ROLE_NAME_RE),
});

const CeilingBodySchema = z.object({
  max_concurrent: z.number().int().nonnegative(),
});

export interface AgentRolesRouteDeps {
  readonly db: Database;
  readonly sessionTokens: SessionTokenStore;
  readonly sessions: SessionStore;
  readonly roles: RoleStore;
  readonly roleVersions: RoleVersionStore;
  readonly workspaceRoles: WorkspaceRoleStore;
  readonly workspaces: WorkspaceStore;
  readonly scheduler: Pick<TriggerScheduler, "reloadRole">;
  // #361 — git-as-truth wiring, so the write verbs can read a commit-pinned
  // source/target role's content from the materialized cache (Option A).
  readonly roleContentCache?: import("../role-content-cache.ts").RoleContentCache;
  readonly roleRepoDir?: string;
  // #216 — the working-copy verbs reach the per-workspace clone + the fork-tip
  // map (for the lazy per-role cutover) through these.
  readonly roleForks?: ReadonlyMap<string, import("../role-repo.ts").ForkRef>;
  readonly workspaceRepos?: import("../workspace-role-repos.ts").WorkspaceRoleRepos;
}

export function registerAgentRolesRoutes(
  app: FastifyInstance,
  deps: AgentRolesRouteDeps,
): void {
  app.get(
    "/agent/roles",
    withAgentAuth("roles.list", deps, async (_request, _reply, { session }) => {
      const roles = deps.roles.listForWorkspace(session.workspace_id);
      const entries: RoleListEntry[] = [];
      for (const role of roles) {
        const entry = buildListEntry(role, deps);
        if (entry !== null) entries.push(entry);
      }
      return { roles: entries };
    }),
  );

  app.post<{ Params: { idOrName: string } }>(
    "/agent/roles/:idOrName/fork",
    withAgentAuth<{ Params: { idOrName: string } }>(
      "roles.fork",
      deps,
      async (request, reply, { session }) => {
        const parsed = ForkBodySchema.safeParse(request.body);
        if (!parsed.success) {
          reply.code(400);
          return { error: "invalid fork request", issues: parsed.error.issues };
        }
        const { idOrName } = request.params;
        const source = resolveRoleByIdOrName(deps.roles, idOrName, session.workspace_id);
        if (source === null || source.workspace_id !== session.workspace_id) {
          reply.code(404);
          return { error: `role not found: ${idOrName}` };
        }
        if (
          deps.roles.findInWorkspace(session.workspace_id, parsed.data.new_name) !==
          null
        ) {
          reply.code(409);
          return { error: `role name already exists: ${parsed.data.new_name}` };
        }
        const result = forkRole(
          deps.db,
          deps,
          source,
          parsed.data.new_name,
          session.workspace_id,
        );
        reply.code(201);
        return result;
      },
    ),
  );

  registerAgentRoleEditRoute(app, deps);

  app.put<{ Params: { idOrName: string } }>(
    "/agent/roles/:idOrName/ceiling",
    withAgentAuth<{ Params: { idOrName: string } }>(
      "roles.ceiling",
      deps,
      async (request, reply, { session }) => {
        const parsed = CeilingBodySchema.safeParse(request.body);
        if (!parsed.success) {
          reply.code(400);
          return { error: "invalid ceiling request", issues: parsed.error.issues };
        }
        const { idOrName } = request.params;
        const role = resolveRoleByIdOrName(deps.roles, idOrName, session.workspace_id);
        if (role === null || role.workspace_id !== session.workspace_id) {
          reply.code(404);
          return { error: `role not found: ${idOrName}` };
        }
        const result = deps.workspaceRoles.setCeiling(
          session.workspace_id,
          role.id,
          parsed.data.max_concurrent,
        );
        reply.code(200);
        return result;
      },
    ),
  );

  app.delete<{ Params: { idOrName: string }; Querystring: { force?: string } }>(
    "/agent/roles/:idOrName",
    withAgentAuth<{ Params: { idOrName: string }; Querystring: { force?: string } }>(
      "roles.delete",
      deps,
      async (request, reply, { session }) => {
        const { idOrName } = request.params;
        const role = resolveRoleByIdOrName(deps.roles, idOrName, session.workspace_id);
        if (role === null || role.workspace_id !== session.workspace_id) {
          reply.code(404);
          return { error: `role not found: ${idOrName}` };
        }
        const force = request.query.force === "true" || request.query.force === "1";
        const violations = evaluateDeleteGuards(
          gatherDeleteGuards(deps.db, deps, role, session.workspace_id),
        );
        const blocking = blockingViolations(violations, force);
        if (blocking.length > 0) {
          reply.code(409);
          return {
            error: `refusing to delete role ${role.name}: ${blocking
              .map((v) => v.detail)
              .join("; ")}`,
            guards: blocking,
            force,
          };
        }
        const result = deleteRole(deps.db, deps, role, session.workspace_id);
        deps.scheduler.reloadRole(role.id);
        reply.code(200);
        return result;
      },
    ),
  );

  app.get<{ Params: { idOrName: string } }>(
    "/agent/roles/:idOrName",
    withAgentAuth<{ Params: { idOrName: string } }>(
      "roles.show",
      deps,
      async (request, reply, { session }) => {
        const { idOrName } = request.params;
        const role = resolveRoleByIdOrName(deps.roles, idOrName, session.workspace_id);
        if (role === null || role.workspace_id !== session.workspace_id) {
          reply.code(404);
          return { error: `role not found: ${idOrName}` };
        }
        const detail = buildDetail(role, deps);
        if (detail === null) {
          reply.code(500);
          return { error: "role has no current version" };
        }
        return detail;
      },
    ),
  );

  // #216 — the working-copy verbs (checkout / status / diff / commit / discard)
  // register on the same auth surface, in their own module to stay reviewable.
  registerAgentRoleCheckoutRoutes(app, deps);
}
