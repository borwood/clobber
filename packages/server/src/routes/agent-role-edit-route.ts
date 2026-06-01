import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  RoleSkillSchema,
  RoleTriggerSchema,
  PromptModuleRefSchema,
  WakeProgramSchema,
} from "@clobber/shared";
import { patchRoleThroughPin, triggersRequirePersistent } from "../role-commit.ts";
import { deskFor } from "../role-checkout-context.ts";
import type { RoleTreeContract } from "../role-tree.ts";
import { resolveRoleByIdOrName } from "../resolve-role.ts";
import { withAgentAuth } from "./_with-agent-auth.ts";
import type { AgentRolesRouteDeps } from "./agent-roles.ts";

// #216/#236/#414 — `roles edit`: a non-interactive one-shot patch of a role's
// content. It is the same git-pin substrate as `checkout`→`commit`, just without
// the working-copy round-trip: the patch fields are applied to the role's current
// contract in-memory and committed onto its branch (advancing the pin, NO new
// version row, NO demotion). `description` is metadata-only and updates the
// `roles` row without advancing the pin. Split out of agent-roles.ts to keep each
// route module under the file-size ceiling.

const EditBodySchema = z
  .object({
    system_prompt: z.string().min(1).optional(),
    skills: z.array(RoleSkillSchema).optional(),
    allowed_tools: z.array(z.string().min(1)).optional(),
    triggers: z.array(RoleTriggerSchema).optional(),
    prompt_module_refs: z.array(PromptModuleRefSchema).optional(),
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
        const patch = parsed.data;
        const advancesPin =
          patch.system_prompt !== undefined ||
          patch.skills !== undefined ||
          patch.allowed_tools !== undefined ||
          patch.triggers !== undefined ||
          patch.prompt_module_refs !== undefined ||
          patch.wake_programs !== undefined;
        if (!advancesPin && patch.description === undefined) {
          reply.code(400);
          return {
            error:
              "edit body must include at least one of system_prompt, skills, allowed_tools, triggers, prompt_module_refs, wake_programs, description",
          };
        }
        const { idOrName } = request.params;
        const role = resolveRoleByIdOrName(deps.roles, idOrName, session.workspace_id);
        if (role === null || role.workspace_id !== session.workspace_id) {
          reply.code(404);
          return { error: `role not found: ${idOrName}` };
        }
        if (triggersRequirePersistent(role, patch.triggers)) {
          reply.code(422);
          return { error: "triggers are only allowed on persistent roles" };
        }

        // Metadata-only: `description` lives in the `roles` row, not the git tree,
        // so a description-only edit updates it without advancing the pin.
        if (!advancesPin) {
          const description = patch.description;
          if (description === undefined) {
            throw new Error("unreachable: non-pin-advancing edit without a description");
          }
          deps.roles.updateDescription(role.id, description);
          reply.code(200);
          return { role_id: role.id, description };
        }

        const deskDir = session.agent_id === undefined ? undefined : deskFor(deps, session);
        const result = patchRoleThroughPin(deps, {
          role,
          workspaceId: session.workspace_id,
          ...(deskDir === undefined ? {} : { deskDir }),
          apply: (current: RoleTreeContract): RoleTreeContract => ({
            ...current,
            ...(patch.system_prompt === undefined ? {} : { systemPrompt: patch.system_prompt }),
            ...(patch.skills === undefined ? {} : { skills: patch.skills }),
            ...(patch.allowed_tools === undefined ? {} : { allowedTools: patch.allowed_tools }),
            ...(patch.triggers === undefined ? {} : { triggers: patch.triggers }),
            ...(patch.prompt_module_refs === undefined ? {} : { seedRefs: patch.prompt_module_refs }),
            ...(patch.wake_programs === undefined ? {} : { wakePrograms: patch.wake_programs }),
          }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          message: `edit ${role.name} via roles edit`,
        });
        reply.code(result.status);
        return result.body;
      },
    ),
  );
}
