import type { FastifyInstance } from "fastify";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { SessionStore } from "../session-store.ts";
import { attachSessionToAgent, type SpawnPipelineDeps } from "../spawn-pipeline.ts";

interface IdParam {
  id: string;
}

export interface PersistentAgentsRouteDeps {
  readonly workspaces: WorkspaceStore;
  readonly agents: AgentStore;
  readonly roles: RoleStore;
  readonly sessions: SessionStore;
  readonly spawnPipelineDeps: SpawnPipelineDeps;
}

export function registerPersistentAgentsRoutes(
  app: FastifyInstance,
  deps: PersistentAgentsRouteDeps,
): void {
  const { workspaces, agents, roles, sessions, spawnPipelineDeps } = deps;

  app.post<{ Params: IdParam }>(
    "/persistent-agents/:id/wake",
    async (request, reply) => {
      const agent = agents.get(request.params.id);
      if (agent === null) {
        reply.code(404);
        return { error: "agent not found" };
      }
      const role = roles.get(agent.role_id);
      if (role === null) {
        reply.code(404);
        return { error: "role not found" };
      }
      if (!role.persistent) {
        reply.code(400);
        return { error: "agent's role is not persistent — use /spawn instead" };
      }
      const workspace = workspaces.get(agent.workspace_id);
      if (workspace === null) {
        reply.code(404);
        return { error: "workspace not found" };
      }

      const activeForWorkspace = sessions.listActiveForWorkspace(workspace.id);
      const alreadyActive = activeForWorkspace.find((s) => s.agent_id === agent.id);
      if (alreadyActive !== undefined) {
        reply.code(409);
        return {
          error: "agent already has an active session",
          session_id: alreadyActive.id,
        };
      }

      const result = await attachSessionToAgent(spawnPipelineDeps, {
        workspace,
        role,
        agent,
        prompt: workspace.wake_prompt,
      });
      if (!result.ok) {
        const { ok: _ok, status, ...rest } = result;
        reply.code(status);
        return rest;
      }
      return {
        agent_id: result.agent_id,
        session_id: result.session_id,
        pid: result.pid,
      };
    },
  );
}
