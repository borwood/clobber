import type { FastifyInstance } from "fastify";
import type { Role } from "@clobber/shared";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { RoleVersionStore } from "../role-version-store.ts";
import { resolveCallerSession } from "./_agent-auth.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AgentRolesRouteDeps {
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
