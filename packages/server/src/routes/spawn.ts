import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { WorkspaceRoleStore } from "../workspace-role-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { AgentSpawner, AgentSpawnRequest } from "../types.ts";
import { endSession } from "../session-lifecycle.ts";

const SpawnBodySchema = z.object({
  workspace_id: z.string().uuid(),
  role_id: z.string().uuid(),
  prompt: z.string().min(1),
  label: z.string().min(1).optional(),
});

export function registerSpawnRoutes(
  app: FastifyInstance,
  deps: {
    workspaces: WorkspaceStore;
    roles: RoleStore;
    workspaceRoles: WorkspaceRoleStore;
    agents: AgentStore;
    sessions: SessionStore;
    spawner: AgentSpawner;
    hookUrl: string;
  },
): void {
  app.post("/spawn", async (request, reply) => {
    const parsed = SpawnBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid spawn request", issues: parsed.error.issues };
    }
    const { workspace_id, role_id, prompt, label } = parsed.data;

    const workspace = deps.workspaces.get(workspace_id);
    if (workspace === null) {
      reply.code(404);
      return { error: "workspace not found" };
    }
    const role = deps.roles.get(role_id);
    if (role === null) {
      reply.code(404);
      return { error: "role not found" };
    }

    const ceilingRow = deps.workspaceRoles.getCeiling(workspace_id, role_id);
    const ceiling = ceilingRow === null ? 0 : ceilingRow.max_concurrent;
    const active = deps.sessions.countActive(workspace_id, role_id);
    if (active >= ceiling) {
      reply.code(403);
      return { error: "role at capacity", ceiling, active };
    }

    const agent = deps.agents.create({
      workspace_id,
      role_id,
      ...(label === undefined ? {} : { label }),
    });

    const spawnReq: AgentSpawnRequest = {
      hookUrl: deps.hookUrl,
      prompt,
      cwd: workspace.repo_path,
      ...(role.permission_mode === undefined
        ? {}
        : { permissionMode: role.permission_mode }),
      ...(role.allowed_tools === undefined
        ? {}
        : { allowedTools: role.allowed_tools }),
    };
    const spawned = deps.spawner(spawnReq);

    deps.sessions.create({
      id: spawned.sessionId,
      agent_id: agent.id,
      workspace_id,
      role_id,
      pid: spawned.pid,
    });

    spawned.exited.then(() => {
      endSession(spawned.sessionId, deps);
    });

    return {
      agent_id: agent.id,
      session_id: spawned.sessionId,
      pid: spawned.pid,
    };
  });
}
