import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { IDLE_WAKE_PROGRAM_NAME } from "@clobber/shared";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { SessionStore } from "../session-store.ts";
import { attachSessionToAgent, type SpawnPipelineDeps } from "../spawn-pipeline.ts";

interface IdParam {
  id: string;
}

// Surface 3 (#213): the human picks the opening move for the persistent agent.
// Default `idle` — boot fully composed (A+B) and wait, never auto-running a
// role program on a human-initiated wake.
const WakeBodySchema = z.object({
  wake_program: z.string().min(1).default(IDLE_WAKE_PROGRAM_NAME),
});

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

      const parsedBody = WakeBodySchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        reply.code(400);
        return { error: "invalid wake request", issues: parsedBody.error.issues };
      }

      // A no-task wake produces no opening user message — durable framing and
      // office continuity ride the composed system prompt instead. The turn-kick
      // (if any) comes from the selected wake-program; `idle` takes none.
      const result = await attachSessionToAgent(spawnPipelineDeps, {
        workspace,
        role,
        agent,
        prompt: undefined,
        wakeProgram: parsedBody.data.wake_program,
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
