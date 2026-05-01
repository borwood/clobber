import type { FastifyInstance } from "fastify";
import { SetWorkspaceRoleCeilingRequestSchema } from "@clobber/shared";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { WorkspaceRoleStore } from "../workspace-role-store.ts";

interface WorkspaceRoleParams {
  wid: string;
  rid: string;
}

interface WorkspaceParam {
  wid: string;
}

export function registerWorkspaceRoleRoutes(
  app: FastifyInstance,
  deps: {
    workspaces: WorkspaceStore;
    roles: RoleStore;
    workspaceRoles: WorkspaceRoleStore;
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
