import type { FastifyInstance } from "fastify";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  ROLE_NAME_RE,
  RoleSkillSchema,
  RoleTriggerSchema,
  SeedRefSchema,
  WakeProgramSchema,
  type RoleListEntry,
} from "@clobber/shared";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { RoleVersionStore } from "../role-version-store.ts";
import type { WorkspaceRoleStore } from "../workspace-role-store.ts";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { TriggerScheduler } from "../trigger-scheduler.ts";
import { forkRole } from "../fork-role.ts";
import { type RoleEditPatch } from "../edit-role.ts";
import { applyRoleEdit, triggersRequirePersistent } from "../apply-role-edit.ts";
import { resolveRoleByIdOrName } from "../resolve-role.ts";
import { resolveCurrentRoleVersion } from "../resolve-role-content.ts";
import { registerAgentRoleCheckoutRoutes } from "./agent-role-checkout.ts";
import { withAgentAuth } from "./_with-agent-auth.ts";
import { buildDetail, buildListEntry } from "./_agent-roles-views.ts";

const ForkBodySchema = z.object({
  new_name: z.string().min(1).regex(ROLE_NAME_RE),
});

const CeilingBodySchema = z.object({
  max_concurrent: z.number().int().nonnegative(),
});

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
            ...(parsed.data.skills === undefined
              ? {}
              : { skills: parsed.data.skills }),
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
