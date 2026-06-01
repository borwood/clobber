import type { FastifyInstance } from "fastify";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  RoleTriggerSchema,
  SetWorkspaceRoleCeilingRequestSchema,
} from "@clobber/shared";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { RoleVersionStore } from "../role-version-store.ts";
import type { RoleContentCache } from "../role-content-cache.ts";
import type { ForkRef } from "../role-repo.ts";
import type { WorkspaceRoleRepos } from "../workspace-role-repos.ts";
import type { WorkspaceRoleStore } from "../workspace-role-store.ts";
import type { TriggerScheduler } from "../trigger-scheduler.ts";
import { patchRoleThroughPin, triggersRequirePersistent } from "../role-commit.ts";
import { resolveRoleByIdOrName } from "../resolve-role.ts";

interface WorkspaceRoleParams {
  wid: string;
  rid: string;
}

interface WorkspaceParam {
  wid: string;
}

const ApplyTriggersBodySchema = z
  .object({ triggers: z.array(RoleTriggerSchema) })
  .strict();

export function registerWorkspaceRoleRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    workspaces: WorkspaceStore;
    roles: RoleStore;
    roleVersions: RoleVersionStore;
    workspaceRoles: WorkspaceRoleStore;
    scheduler: Pick<TriggerScheduler, "reloadRole">;
    // #385/#414 — present iff git-as-truth is configured; lets the operator
    // triggers route source a commit-pinned role's content from the cache and
    // commit the patch onto its per-workspace clone (advancing the pin).
    roleContentCache?: RoleContentCache;
    roleRepoDir?: string;
    roleForks?: ReadonlyMap<string, ForkRef>;
    workspaceRepos?: WorkspaceRoleRepos;
  },
): void {
  const { workspaces, roles, workspaceRoles } = deps;

  app.put<{ Params: WorkspaceRoleParams }>(
    "/workspaces/:wid/roles/:rid",
    async (request, reply) => {
      const parsed = SetWorkspaceRoleCeilingRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid ceiling request", issues: parsed.error.issues };
      }
      if (workspaces.get(request.params.wid) === null) {
        reply.code(404);
        return { error: "workspace not found" };
      }
      if (roles.get(request.params.rid) === null) {
        reply.code(404);
        return { error: "role not found" };
      }
      return workspaceRoles.setCeiling(
        request.params.wid,
        request.params.rid,
        parsed.data.max_concurrent,
      );
    },
  );

  // Operator-level (no agent auth, like POST /workspaces and the ceiling PUT
  // above): the caller has no session in the target workspace, which is exactly
  // why the loader (#181) cannot use the agent-scoped PATCH /agent/roles/:id.
  app.put<{ Params: WorkspaceRoleParams }>(
    "/workspaces/:wid/roles/:rid/triggers",
    async (request, reply) => {
      const parsed = ApplyTriggersBodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid triggers request", issues: parsed.error.issues };
      }
      const { wid, rid } = request.params;
      if (workspaces.get(wid) === null) {
        reply.code(404);
        return { error: "workspace not found" };
      }
      const role = resolveRoleByIdOrName(roles, rid, wid);
      if (role === null || role.workspace_id !== wid) {
        reply.code(404);
        return { error: `role not found: ${rid}` };
      }
      if (triggersRequirePersistent(role, parsed.data.triggers)) {
        reply.code(422);
        return { error: "triggers are only allowed on persistent roles" };
      }
      // #414 — the operator triggers edit is a one-shot patch through the git
      // pin: read the role's current contract from the pinned tree, swap in the
      // new triggers, and commit onto its branch (no version row, no demotion).
      const result = patchRoleThroughPin(deps, {
        role,
        workspaceId: wid,
        apply: (current) => ({ ...current, triggers: parsed.data.triggers }),
        message: `apply triggers to ${role.name}`,
      });
      reply.code(result.status);
      return result.body;
    },
  );

  app.get<{ Params: WorkspaceParam }>("/workspaces/:wid/roles", async (request, reply) => {
    if (workspaces.get(request.params.wid) === null) {
      reply.code(404);
      return { error: "workspace not found" };
    }
    return workspaceRoles.listForWorkspace(request.params.wid);
  });

  app.delete<{ Params: WorkspaceRoleParams }>(
    "/workspaces/:wid/roles/:rid",
    async (request, reply) => {
      const removed = workspaceRoles.removeCeiling(request.params.wid, request.params.rid);
      if (!removed) {
        reply.code(404);
        return { error: "ceiling not found" };
      }
      reply.code(204);
      return null;
    },
  );
}
