import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { WorkspaceRoleStore } from "../workspace-role-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import type { AgentSpawner } from "../types.ts";
import { executeSpawn } from "../spawn-pipeline.ts";
import { resolveCallerSession } from "./_agent-auth.ts";

export interface AgentRouteDeps {
  readonly sessionTokens: SessionTokenStore;
  readonly sessions: SessionStore;
  readonly roles: RoleStore;
  readonly workspaces: WorkspaceStore;
  readonly workspaceRoles: WorkspaceRoleStore;
  readonly agents: AgentStore;
  readonly registry: AgentRegistry;
  readonly spawner: AgentSpawner;
  readonly hookUrl: string;
  readonly apiBase: string;
  readonly cliEntry: string;
}

const AgentSpawnBodySchema = z.object({
  role: z.string().min(1),
  prompt: z.string().min(1),
  label: z.string().min(1).optional(),
});

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  app.get("/agent/me", async (request, reply) => {
    const auth = resolveCallerSession(request, deps);
    if (!auth.ok) {
      reply.code(auth.status);
      return { error: auth.error };
    }
    const role = deps.roles.get(auth.session.role_id);
    if (role === null) {
      reply.code(500);
      return { error: "role missing for session" };
    }
    return {
      session_id: auth.session.id,
      workspace_id: auth.session.workspace_id,
      role: { id: role.id, name: role.name },
      started_at: auth.session.started_at,
    };
  });

  app.post("/agent/spawn", async (request, reply) => {
    const auth = resolveCallerSession(request, deps);
    if (!auth.ok) {
      reply.code(auth.status);
      return { error: auth.error };
    }

    const parsed = AgentSpawnBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid spawn request", issues: parsed.error.issues };
    }
    const { role: roleName, prompt, label } = parsed.data;

    const workspace = deps.workspaces.get(auth.session.workspace_id);
    if (workspace === null) {
      reply.code(500);
      return { error: "workspace missing for session" };
    }
    const role = deps.roles.findByName(roleName);
    if (role === null) {
      reply.code(404);
      return { error: `role not found: ${roleName}` };
    }

    const result = executeSpawn(deps, {
      workspace,
      role,
      prompt,
      ...(label === undefined ? {} : { label }),
    });
    if (!result.ok) {
      reply.code(result.status);
      return { error: result.error, ceiling: result.ceiling, active: result.active };
    }
    return {
      agent_id: result.agent_id,
      session_id: result.session_id,
      pid: result.pid,
    };
  });
}
