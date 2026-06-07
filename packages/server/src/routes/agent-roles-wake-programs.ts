import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { WakeProgramSchema, WakeProgramsSchema, IDLE_WAKE_PROGRAM_NAME } from "@clobber/shared";
import { resolveRoleByIdOrName } from "../resolve-role.ts";
import { resolveCurrentRoleVersion } from "../resolve-role-content.ts";
import { patchRoleThroughPin } from "../role-commit.ts";
import { deskFor } from "../role-checkout-context.ts";
import { withAgentAuth } from "./_with-agent-auth.ts";
import type { AgentRolesRouteDeps } from "./agent-roles.ts";

// #551 — dedicated routes for per-role wake-program management, giving each
// mutating verb its own dotted commandName distinct from the general `roles.edit`.
//   POST   /agent/roles/:id/wake-programs        → "roles.wake-programs.add"
//   PATCH  /agent/roles/:id/wake-programs/:name  → "roles.wake-programs.edit"
//   DELETE /agent/roles/:id/wake-programs/:name  → "roles.wake-programs.remove"

const AddBodySchema = WakeProgramSchema;

const EditBodySchema = z
  .object({
    system: z.string().optional(),
    user: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine((d) => d.system !== undefined || d.user !== undefined, {
    message: "at least one of system or user must be provided",
  });

interface IdOrNameParams {
  idOrName: string;
}

interface NamedProgramParams {
  idOrName: string;
  name: string;
}

export function registerAgentRolesWakeProgramsRoutes(
  app: FastifyInstance,
  deps: AgentRolesRouteDeps,
): void {
  app.post<{ Params: IdOrNameParams }>(
    "/agent/roles/:idOrName/wake-programs",
    withAgentAuth<{ Params: IdOrNameParams }>(
      "roles.wake-programs.add",
      deps,
      async (request, reply, { session }) => {
        const parsed = AddBodySchema.safeParse(request.body);
        if (!parsed.success) {
          reply.code(400);
          return { error: "invalid add request", issues: parsed.error.issues };
        }
        if (parsed.data.name === IDLE_WAKE_PROGRAM_NAME) {
          reply.code(422);
          return { error: `'${IDLE_WAKE_PROGRAM_NAME}' is the reserved built-in and cannot be authored` };
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
        const programs = WakeProgramsSchema.parse(JSON.parse(version.wake_programs_json));
        if (programs.some((p) => p.name === parsed.data.name)) {
          reply.code(409);
          return { error: `wake-program '${parsed.data.name}' already exists on role '${role.name}'` };
        }
        const next = [...programs, parsed.data];
        const deskDir = session.agent_id === undefined ? undefined : deskFor(deps, session);
        const result = patchRoleThroughPin(deps, {
          role,
          workspaceId: session.workspace_id,
          ...(deskDir === undefined ? {} : { deskDir }),
          apply: (current) => ({ ...current, wakePrograms: next }),
          message: `wake-programs add ${parsed.data.name} on ${role.name}`,
        });
        reply.code(result.status);
        if (result.status !== 200) return result.body;
        return { ...(result.body as object), wake_programs: next };
      },
    ),
  );

  app.patch<{ Params: NamedProgramParams }>(
    "/agent/roles/:idOrName/wake-programs/:name",
    withAgentAuth<{ Params: NamedProgramParams }>(
      "roles.wake-programs.edit",
      deps,
      async (request, reply, { session }) => {
        const parsed = EditBodySchema.safeParse(request.body);
        if (!parsed.success) {
          reply.code(400);
          return { error: "invalid edit request", issues: parsed.error.issues };
        }
        if (request.params.name === IDLE_WAKE_PROGRAM_NAME) {
          reply.code(422);
          return { error: `'${IDLE_WAKE_PROGRAM_NAME}' is the reserved built-in and cannot be edited` };
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
        const programs = WakeProgramsSchema.parse(JSON.parse(version.wake_programs_json));
        const current = programs.find((p) => p.name === request.params.name);
        if (current === undefined) {
          reply.code(404);
          return { error: `wake-program '${request.params.name}' not found on role '${role.name}'` };
        }
        const updated = {
          name: current.name,
          system: parsed.data.system !== undefined ? parsed.data.system : current.system,
          user: parsed.data.user !== undefined ? parsed.data.user : current.user,
        };
        const next = programs.map((p) => (p.name === request.params.name ? updated : p));
        const deskDir = session.agent_id === undefined ? undefined : deskFor(deps, session);
        const result = patchRoleThroughPin(deps, {
          role,
          workspaceId: session.workspace_id,
          ...(deskDir === undefined ? {} : { deskDir }),
          apply: (current) => ({ ...current, wakePrograms: next }),
          message: `wake-programs edit ${request.params.name} on ${role.name}`,
        });
        reply.code(result.status);
        if (result.status !== 200) return result.body;
        return { ...(result.body as object), wake_programs: next };
      },
    ),
  );

  app.delete<{ Params: NamedProgramParams }>(
    "/agent/roles/:idOrName/wake-programs/:name",
    withAgentAuth<{ Params: NamedProgramParams }>(
      "roles.wake-programs.remove",
      deps,
      async (request, reply, { session }) => {
        if (request.params.name === IDLE_WAKE_PROGRAM_NAME) {
          reply.code(422);
          return { error: `'${IDLE_WAKE_PROGRAM_NAME}' is the reserved built-in and cannot be removed` };
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
        const programs = WakeProgramsSchema.parse(JSON.parse(version.wake_programs_json));
        if (!programs.some((p) => p.name === request.params.name)) {
          reply.code(404);
          return { error: `wake-program '${request.params.name}' not found on role '${role.name}'` };
        }
        const next = programs.filter((p) => p.name !== request.params.name);
        const deskDir = session.agent_id === undefined ? undefined : deskFor(deps, session);
        const result = patchRoleThroughPin(deps, {
          role,
          workspaceId: session.workspace_id,
          ...(deskDir === undefined ? {} : { deskDir }),
          apply: (current) => ({ ...current, wakePrograms: next }),
          message: `wake-programs remove ${request.params.name} on ${role.name}`,
        });
        reply.code(result.status);
        if (result.status !== 200) return result.body;
        return { ...(result.body as object), wake_programs: next };
      },
    ),
  );
}
