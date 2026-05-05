import type { FastifyInstance } from "fastify";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import { officePathFor } from "../office-store.ts";
import { peekOffice, type OfficePeek } from "../office-peek.ts";
import { attachSessionToAgent, type SpawnPipelineDeps } from "../spawn-pipeline.ts";

interface IdParam {
  id: string;
}

interface AgentCard {
  agent_id: string;
  label: string | null;
  role: { id: string; name: string };
  active_session: { id: string; started_at: number; busy: boolean } | null;
  last_started_at: number | null;
  office: OfficePeek;
}

export interface PersistentAgentsRouteDeps {
  readonly workspaces: WorkspaceStore;
  readonly agents: AgentStore;
  readonly roles: RoleStore;
  readonly sessions: SessionStore;
  readonly registry: AgentRegistry;
  readonly spawnPipelineDeps: SpawnPipelineDeps;
}

const DEFAULT_WAKE_PROMPT =
  "You have been woken without a specific task. Review your office notes, then summarise where you left off and what (if anything) needs your attention next.";

export function registerPersistentAgentsRoutes(
  app: FastifyInstance,
  deps: PersistentAgentsRouteDeps,
): void {
  const { workspaces, agents, roles, sessions, registry, spawnPipelineDeps } = deps;

  app.get<{ Params: IdParam }>(
    "/workspaces/:id/persistent-agents",
    async (request, reply) => {
      const workspace = workspaces.get(request.params.id);
      if (workspace === null) {
        reply.code(404);
        return { error: "workspace not found" };
      }

      const allAgents = agents.listForWorkspace(workspace.id);
      const activeSessions = sessions.listActiveForWorkspace(workspace.id);
      const allWorkspaceSessions = sessions.listForWorkspace(workspace.id);

      const cards: AgentCard[] = [];
      for (const agent of allAgents) {
        const role = roles.get(agent.role_id);
        if (role === null) continue;
        if (!role.persistent) continue;

        const active = activeSessions.find((s) => s.agent_id === agent.id);
        const live = active === undefined ? null : registry.get(active.id);

        const lastSession = allWorkspaceSessions.find((s) => s.agent_id === agent.id);

        cards.push({
          agent_id: agent.id,
          label: agent.label === undefined ? null : agent.label,
          role: { id: role.id, name: role.name },
          active_session:
            active === undefined
              ? null
              : {
                  id: active.id,
                  started_at: active.started_at,
                  busy: live === null ? false : live.busy,
                },
          last_started_at: lastSession === undefined ? null : lastSession.started_at,
          office: peekOffice(officePathFor(workspace.repo_path, agent.id)),
        });
      }

      return { agents: cards };
    },
  );

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

      const result = attachSessionToAgent(spawnPipelineDeps, {
        workspace,
        role,
        agent,
        prompt: DEFAULT_WAKE_PROMPT,
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
