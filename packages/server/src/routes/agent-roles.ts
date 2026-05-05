import type { FastifyInstance } from "fastify";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Role } from "@clobber/shared";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { RoleVersionStore } from "../role-version-store.ts";
import { forkRole } from "../fork-role.ts";
import { editRole, type RoleEditPatch } from "../edit-role.ts";
import { resolveCallerSession } from "./_agent-auth.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_NAME_RE = /^[A-Za-z0-9_-]+$/;

const ForkBodySchema = z.object({
  new_name: z.string().min(1).regex(ROLE_NAME_RE),
});

const RoleSkillSchema = z.object({
  name: z.string().min(1),
  body: z.string().min(1),
});

const EditBodySchema = z
  .object({
    system_prompt: z.string().min(1).optional(),
    skills: z.array(RoleSkillSchema).optional(),
    allowed_tools: z.array(z.string().min(1)).optional(),
  })
  .strict();

const FORBIDDEN_EDIT_KEYS = ["hooks", "permission_mode"] as const;

export interface AgentRolesRouteDeps {
  readonly db: Database;
  readonly sessionTokens: SessionTokenStore;
  readonly sessions: SessionStore;
  readonly roles: RoleStore;
  readonly roleVersions: RoleVersionStore;
}

interface RoleListEntry {
  readonly id: string;
  readonly name: string;
  readonly persistent: boolean;
  readonly description?: string;
  readonly allowed_tools?: readonly string[];
  readonly current_version_id: string;
  readonly version: number;
  readonly created_at: number;
}

function buildListEntry(
  role: Role,
  deps: AgentRolesRouteDeps,
): RoleListEntry | null {
  if (role.current_version_id === undefined) return null;
  const version = deps.roleVersions.get(role.current_version_id);
  if (version === null) return null;
  const entry: Record<string, unknown> = {
    id: role.id,
    name: role.name,
    persistent: role.persistent,
    current_version_id: role.current_version_id,
    version: version.version,
    created_at: role.created_at,
  };
  if (role.description !== undefined) entry["description"] = role.description;
  if (role.allowed_tools !== undefined) {
    entry["allowed_tools"] = role.allowed_tools;
  }
  return entry as unknown as RoleListEntry;
}

interface RoleDetailResponse {
  readonly id: string;
  readonly name: string;
  readonly persistent: boolean;
  readonly description?: string;
  readonly current_version: {
    readonly id: string;
    readonly version: number;
    readonly system_prompt: string;
    readonly skills: unknown;
    readonly allowed_tools: unknown;
    readonly hooks: unknown;
    readonly created_at: number;
  };
  readonly version_history: ReadonlyArray<{
    readonly id: string;
    readonly version: number;
    readonly created_at: number;
  }>;
}

function buildDetail(
  role: Role,
  deps: AgentRolesRouteDeps,
): RoleDetailResponse | null {
  if (role.current_version_id === undefined) return null;
  const version = deps.roleVersions.get(role.current_version_id);
  if (version === null) return null;
  const detail: Record<string, unknown> = {
    id: role.id,
    name: role.name,
    persistent: role.persistent,
    current_version: {
      id: version.id,
      version: version.version,
      system_prompt: version.system_prompt,
      skills: JSON.parse(version.skills_json),
      allowed_tools: JSON.parse(version.allowed_tools_json),
      hooks: JSON.parse(version.hooks_json),
      created_at: version.created_at,
    },
    version_history: deps.roleVersions.listForRole(role.id),
  };
  if (role.description !== undefined) detail["description"] = role.description;
  return detail as unknown as RoleDetailResponse;
}

export function registerAgentRolesRoutes(
  app: FastifyInstance,
  deps: AgentRolesRouteDeps,
): void {
  app.get("/agent/roles", async (request, reply) => {
    const auth = resolveCallerSession(request, deps);
    if (!auth.ok) {
      reply.code(auth.status);
      return { error: auth.error };
    }
    const roles = deps.roles.listForWorkspace(auth.session.workspace_id);
    const entries: RoleListEntry[] = [];
    for (const role of roles) {
      const entry = buildListEntry(role, deps);
      if (entry !== null) entries.push(entry);
    }
    return { roles: entries };
  });

  app.post<{ Params: { idOrName: string } }>(
    "/agent/roles/:idOrName/fork",
    async (request, reply) => {
      const auth = resolveCallerSession(request, deps);
      if (!auth.ok) {
        reply.code(auth.status);
        return { error: auth.error };
      }
      const parsed = ForkBodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid fork request", issues: parsed.error.issues };
      }
      const { idOrName } = request.params;
      const source = UUID_RE.test(idOrName)
        ? deps.roles.get(idOrName)
        : deps.roles.findInWorkspace(auth.session.workspace_id, idOrName);
      if (source === null || source.workspace_id !== auth.session.workspace_id) {
        reply.code(404);
        return { error: `role not found: ${idOrName}` };
      }
      if (source.current_version_id === undefined) {
        reply.code(500);
        return { error: "source role has no current version" };
      }
      const sourceVersion = deps.roleVersions.get(source.current_version_id);
      if (sourceVersion === null) {
        reply.code(500);
        return { error: "source role version missing" };
      }
      if (
        deps.roles.findInWorkspace(auth.session.workspace_id, parsed.data.new_name) !==
        null
      ) {
        reply.code(409);
        return { error: `role name already exists: ${parsed.data.new_name}` };
      }
      const result = forkRole(
        deps.db,
        source,
        sourceVersion,
        parsed.data.new_name,
        auth.session.workspace_id,
      );
      reply.code(201);
      return result;
    },
  );

  app.patch<{ Params: { idOrName: string } }>(
    "/agent/roles/:idOrName",
    async (request, reply) => {
      const auth = resolveCallerSession(request, deps);
      if (!auth.ok) {
        reply.code(auth.status);
        return { error: auth.error };
      }
      const rawBody =
        request.body === null || typeof request.body !== "object"
          ? null
          : (request.body as Record<string, unknown>);
      if (rawBody === null) {
        reply.code(400);
        return { error: "edit body must be a JSON object" };
      }
      for (const key of FORBIDDEN_EDIT_KEYS) {
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
      if (
        parsed.data.system_prompt === undefined &&
        parsed.data.skills === undefined &&
        parsed.data.allowed_tools === undefined
      ) {
        reply.code(400);
        return {
          error:
            "edit body must include at least one of system_prompt, skills, allowed_tools",
        };
      }
      const { idOrName } = request.params;
      const role = UUID_RE.test(idOrName)
        ? deps.roles.get(idOrName)
        : deps.roles.findInWorkspace(auth.session.workspace_id, idOrName);
      if (role === null || role.workspace_id !== auth.session.workspace_id) {
        reply.code(404);
        return { error: `role not found: ${idOrName}` };
      }
      if (role.current_version_id === undefined) {
        reply.code(500);
        return { error: "role has no current version" };
      }
      const currentVersion = deps.roleVersions.get(role.current_version_id);
      if (currentVersion === null) {
        reply.code(500);
        return { error: "role current version missing" };
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
      };
      const result = editRole(deps.db, role, currentVersion, patch);
      reply.code(200);
      return result;
    },
  );

  app.get<{ Params: { idOrName: string } }>(
    "/agent/roles/:idOrName",
    async (request, reply) => {
      const auth = resolveCallerSession(request, deps);
      if (!auth.ok) {
        reply.code(auth.status);
        return { error: auth.error };
      }
      const { idOrName } = request.params;
      const role = UUID_RE.test(idOrName)
        ? deps.roles.get(idOrName)
        : deps.roles.findInWorkspace(auth.session.workspace_id, idOrName);
      if (role === null || role.workspace_id !== auth.session.workspace_id) {
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
  );
}
