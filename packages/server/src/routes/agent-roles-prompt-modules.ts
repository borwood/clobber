import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PromptModuleRefSchema, PromptModuleRefsSchema } from "@clobber/shared";
import { resolveRoleByIdOrName } from "../resolve-role.ts";
import { resolveCurrentRoleVersion } from "../resolve-role-content.ts";
import { patchRoleThroughPin } from "../role-commit.ts";
import { deskFor } from "../role-checkout-context.ts";
import { withAgentAuth } from "./_with-agent-auth.ts";
import type { AgentRolesRouteDeps } from "./agent-roles.ts";

// #551 — dedicated routes for per-role prompt-module ref management, giving each
// mutating verb its own dotted commandName distinct from the general `roles.edit`.
//   POST   /agent/roles/:id/prompt-modules        → "roles.prompt-modules.add"
//   PATCH  /agent/roles/:id/prompt-modules/:name  → "roles.prompt-modules.toggle"

const AddBodySchema = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean().optional(),
  })
  .strict();

const ToggleBodySchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

interface IdOrNameParams {
  idOrName: string;
}

interface NamedRefParams {
  idOrName: string;
  name: string;
}

export function registerAgentRolesPromptModulesRoutes(
  app: FastifyInstance,
  deps: AgentRolesRouteDeps,
): void {
  app.post<{ Params: IdOrNameParams }>(
    "/agent/roles/:idOrName/prompt-modules",
    withAgentAuth<{ Params: IdOrNameParams }>(
      "roles.prompt-modules.add",
      deps,
      async (request, reply, { session }) => {
        const parsed = AddBodySchema.safeParse(request.body);
        if (!parsed.success) {
          reply.code(400);
          return { error: "invalid add request", issues: parsed.error.issues };
        }
        const role = resolveRoleByIdOrName(
          deps.roles,
          request.params.idOrName,
          session.workspace_id,
        );
        if (role === null || role.workspace_id !== session.workspace_id) {
          reply.code(404);
          return { error: `role not found: ${request.params.idOrName}` };
        }
        const version = resolveCurrentRoleVersion(role, deps);
        if (version === null) {
          reply.code(500);
          return { error: `role '${role.name}' has no current version` };
        }
        const refs = PromptModuleRefsSchema.parse(JSON.parse(version.seed_refs_json));
        if (refs.some((r) => r.name === parsed.data.name)) {
          reply.code(409);
          return { error: `module '${parsed.data.name}' is already on role '${role.name}'` };
        }
        const next = [...refs, { name: parsed.data.name, enabled: parsed.data.enabled ?? true }];
        const deskDir = session.agent_id === undefined ? undefined : deskFor(deps, session);
        const result = patchRoleThroughPin(deps, {
          role,
          workspaceId: session.workspace_id,
          ...(deskDir === undefined ? {} : { deskDir }),
          apply: (current) => ({ ...current, seedRefs: next }),
          message: `prompt-modules add ${parsed.data.name} on ${role.name}`,
        });
        reply.code(result.status);
        if (result.status !== 200) return result.body;
        return { ...(result.body as object), prompt_module_refs: next };
      },
    ),
  );

  app.patch<{ Params: NamedRefParams }>(
    "/agent/roles/:idOrName/prompt-modules/:name",
    withAgentAuth<{ Params: NamedRefParams }>(
      "roles.prompt-modules.toggle",
      deps,
      async (request, reply, { session }) => {
        const parsed = ToggleBodySchema.safeParse(request.body);
        if (!parsed.success) {
          reply.code(400);
          return { error: "invalid toggle request", issues: parsed.error.issues };
        }
        const role = resolveRoleByIdOrName(
          deps.roles,
          request.params.idOrName,
          session.workspace_id,
        );
        if (role === null || role.workspace_id !== session.workspace_id) {
          reply.code(404);
          return { error: `role not found: ${request.params.idOrName}` };
        }
        const version = resolveCurrentRoleVersion(role, deps);
        if (version === null) {
          reply.code(500);
          return { error: `role '${role.name}' has no current version` };
        }
        const refs = PromptModuleRefsSchema.parse(JSON.parse(version.seed_refs_json));
        const ref = refs.find((r) => r.name === request.params.name);
        if (ref === undefined) {
          reply.code(404);
          return {
            error: `module '${request.params.name}' is not ref'd on role '${role.name}'`,
          };
        }
        const next = refs.map((r) =>
          r.name === request.params.name
            ? { ...r, enabled: parsed.data.enabled }
            : r,
        );
        const deskDir = session.agent_id === undefined ? undefined : deskFor(deps, session);
        const result = patchRoleThroughPin(deps, {
          role,
          workspaceId: session.workspace_id,
          ...(deskDir === undefined ? {} : { deskDir }),
          apply: (current) => ({ ...current, seedRefs: next }),
          message: `prompt-modules toggle ${request.params.name} enabled=${parsed.data.enabled} on ${role.name}`,
        });
        reply.code(result.status);
        if (result.status !== 200) return result.body;
        return { ...(result.body as object), prompt_module_refs: next };
      },
    ),
  );
}
