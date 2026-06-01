import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  RoleSkillSchema,
  RoleTriggerSchema,
  SeedRefSchema,
  WakeProgramSchema,
} from "@clobber/shared";
import { type RoleEditPatch } from "../edit-role.ts";
import { applyRoleEdit, triggersRequirePersistent } from "../apply-role-edit.ts";
import { resolveRoleByIdOrName } from "../resolve-role.ts";
import { resolveCurrentRoleVersion } from "../resolve-role-content.ts";
import { withAgentAuth } from "./_with-agent-auth.ts";
import type { AgentRolesRouteDeps } from "./agent-roles.ts";

// #216/#236 — `roles edit`: patch a role's content. system_prompt / skills /
// allowed_tools / triggers / seed_refs / wake_programs bump a version row;
// description is metadata-only and does not. Split out of agent-roles.ts to keep
// each route module under the file-size ceiling.

const EditBodySchema = z
  .object({
    system_prompt: z.string().min(1).optional(),
    skills: z.array(RoleSkillSchema).optional(),
    allowed_tools: z.array(z.string().min(1)).optional(),
    triggers: z.array(RoleTriggerSchema).optional(),
    seed_refs: z.array(SeedRefSchema).optional(),
    wake_programs: z.array(WakeProgramSchema).optional(),
    description: z.string().min(1).optional(),
  })
  .strict();

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
        const rawBody =
          request.body === null || typeof request.body !== "object"
            ? null
            : (request.body as Record<string, unknown>);
        if (rawBody === null) {
          reply.code(400);
          return { error: "edit body must be a JSON object" };
        }
        const workspace = deps.workspaces.get(session.workspace_id);
        if (workspace === null) {
          reply.code(404);
          return { error: "workspace not found" };
        }
        for (const key of workspace.role_edit_policy.forbidden_keys) {
          if (key in rawBody) {
            reply.code(400);
            return { error: `${key} is not editable via PATCH /agent/roles/:id` };
          }
        }
        const parsed = EditBodySchema.safeParse(rawBody);
        if (!parsed.success) {
          reply.code(400);
          return { error: "invalid edit request", issues: parsed.error.issues };
        }
        const versionBumping =
          parsed.data.system_prompt !== undefined ||
          parsed.data.skills !== undefined ||
          parsed.data.allowed_tools !== undefined ||
          parsed.data.triggers !== undefined ||
          parsed.data.seed_refs !== undefined ||
          parsed.data.wake_programs !== undefined;
        if (!versionBumping && parsed.data.description === undefined) {
          reply.code(400);
          return {
            error:
              "edit body must include at least one of system_prompt, skills, allowed_tools, triggers, seed_refs, wake_programs, description",
          };
        }
        const { idOrName } = request.params;
        const role = resolveRoleByIdOrName(deps.roles, idOrName, session.workspace_id);
        if (role === null || role.workspace_id !== session.workspace_id) {
          reply.code(404);
          return { error: `role not found: ${idOrName}` };
        }
        if (triggersRequirePersistent(role, parsed.data.triggers)) {
          reply.code(422);
          return { error: "triggers are only allowed on persistent roles" };
        }
        if (parsed.data.description !== undefined) {
          deps.roles.updateDescription(role.id, parsed.data.description);
        }
        const response: {
          role_id: string;
          version_id?: string;
          version?: number;
          description?: string;
        } = { role_id: role.id };
        if (parsed.data.description !== undefined) {
          response.description = parsed.data.description;
        }
        if (versionBumping) {
          const currentVersion = resolveCurrentRoleVersion(role, deps);
          if (currentVersion === null) {
            reply.code(500);
            return { error: "role has no current version" };
          }
          const patch: RoleEditPatch = {
            ...(parsed.data.system_prompt === undefined
              ? {}
              : { system_prompt: parsed.data.system_prompt }),
            ...(parsed.data.skills === undefined ? {} : { skills: parsed.data.skills }),
            ...(parsed.data.allowed_tools === undefined
              ? {}
              : { allowed_tools: parsed.data.allowed_tools }),
            ...(parsed.data.triggers === undefined
              ? {}
              : { triggers: parsed.data.triggers }),
            ...(parsed.data.seed_refs === undefined
              ? {}
              : { seedRefs: parsed.data.seed_refs }),
            ...(parsed.data.wake_programs === undefined
              ? {}
              : { wakePrograms: parsed.data.wake_programs }),
          };
          const result = applyRoleEdit(deps.db, deps.scheduler, role, currentVersion, patch);
          response.version_id = result.version_id;
          response.version = result.version;
        }
        reply.code(200);
        return response;
      },
    ),
  );
}
