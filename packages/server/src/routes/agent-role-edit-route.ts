import type { FastifyInstance } from "fastify";
import { deskFor } from "../role-checkout-context.ts";
import { applyRoleEdit } from "../role-edit-apply.ts";
import { resolveRoleByIdOrName } from "../resolve-role.ts";
import { withAgentAuth } from "./_with-agent-auth.ts";
import type { AgentRolesRouteDeps } from "./agent-roles.ts";

// #216/#236/#414 — `roles edit`: a non-interactive one-shot patch of a role's
// content. It is the same git-pin substrate as `checkout`→`commit`, just without
// the working-copy round-trip. The body handling (validation, forbidden-key
// policy, the metadata-only `description` fast-path, the persistent-only trigger
// guard, the git-pin patch) lives in `applyRoleEdit` so this agent-scoped route
// and the operator-scoped PATCH /workspaces/:wid/roles/:rid stay one source.

export function registerAgentRoleEditRoute(
  app: FastifyInstance,
  deps: AgentRolesRouteDeps,
): void {
  app.patch<{ Params: { idOrName: string } }>(
    "/agent/roles/:idOrName",
    withAgentAuth<{ Params: { idOrName: string } }>(
      "roles.edit",
      deps,
      async (request, reply, { session }) => {
        const workspace = deps.workspaces.get(session.workspace_id);
        if (workspace === null) {
          reply.code(404);
          return { error: "workspace not found" };
        }
        const { idOrName } = request.params;
        const role = resolveRoleByIdOrName(deps.roles, idOrName, session.workspace_id);
        if (role === null || role.workspace_id !== session.workspace_id) {
          reply.code(404);
          return { error: `role not found: ${idOrName}` };
        }
        const deskDir = session.agent_id === undefined ? undefined : deskFor(deps, session);
        const result = applyRoleEdit(deps, {
          rawBody: request.body,
          role,
          workspaceId: session.workspace_id,
          forbiddenKeys: workspace.role_edit_policy.forbidden_keys,
          ...(deskDir === undefined ? {} : { deskDir }),
          message: `edit ${role.name} via roles edit`,
        });
        reply.code(result.status);
        return result.body;
      },
    ),
  );
}
