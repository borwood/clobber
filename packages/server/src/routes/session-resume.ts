import type { FastifyInstance } from "fastify";
import type { SessionStore } from "../session-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { WorkspaceStore } from "../workspace-store.ts";
import { rearmPending, type RearmPendingDeps } from "../notification-rearm.ts";
import { attachSessionToAgent, type SpawnPipelineDeps } from "../spawn-pipeline.ts";
import type { ResumeEndedResult } from "../resume-pipeline.ts";

interface IdParam {
  id: string;
}

export interface SessionResumeRouteDeps {
  readonly sessions: SessionStore;
  readonly agents: AgentStore;
  readonly roles: RoleStore;
  readonly workspaces: WorkspaceStore;
  readonly spawnPipelineDeps: SpawnPipelineDeps;
  readonly rearmDeps: RearmPendingDeps;
  readonly resumeEnded: (input: {
    readonly sessionId: string;
    readonly prompt: string | undefined;
  }) => Promise<ResumeEndedResult>;
}

export function registerSessionResumeRoutes(app: FastifyInstance, deps: SessionResumeRouteDeps): void {
  // Confirm: resume the dead worker session and deliver its queued rows.
  app.post<{ Params: IdParam }>(
    "/sessions/:id/confirm-resume",
    async (request, reply) => {
      const sessionId = request.params.id;
      const session = deps.sessions.get(sessionId);
      if (session === null) {
        reply.code(404);
        return { error: "session not found" };
      }
      if (session.ended_at === undefined) {
        reply.code(409);
        return { error: "session is still active" };
      }
      if (session.agent_id === undefined) {
        reply.code(422);
        return { error: "session has no agent" };
      }

      const agent = deps.agents.get(session.agent_id);
      if (agent === null) {
        reply.code(422);
        return { error: "agent not found" };
      }
      const role = deps.roles.get(agent.role_id);
      if (role === null) {
        reply.code(422);
        return { error: "role not found" };
      }
      const workspace = deps.workspaces.get(agent.workspace_id);
      if (workspace === null) {
        reply.code(422);
        return { error: "workspace not found" };
      }

      // Try the native runtime resume (session-history-preserving) first.
      // Falls back to a fresh attach when the session has no provider_thread_id
      // or the runtime doesn't support resume — queued rows are delivered either
      // way via the rearmPending call below.
      const resumeResult = await deps.resumeEnded({ sessionId, prompt: undefined });
      let newSessionId: string;

      if (resumeResult.ok) {
        newSessionId = resumeResult.session_id;
      } else {
        const spawnResult = await attachSessionToAgent(deps.spawnPipelineDeps, {
          workspace,
          role,
          agent,
          prompt: undefined,
        });
        if (!spawnResult.ok) {
          reply.code(503);
          return { error: spawnResult.error };
        }
        newSessionId = spawnResult.session_id;
      }

      // Deliver any queued rows to the freshly resumed/spawned session.
      await rearmPending(deps.rearmDeps, agent.id);

      return { ok: true, session_id: newSessionId };
    },
  );

  // Decline: leave queued rows where they are; no new session spawned.
  app.post<{ Params: IdParam }>(
    "/sessions/:id/decline-resume",
    async (request, reply) => {
      const sessionId = request.params.id;
      const session = deps.sessions.get(sessionId);
      if (session === null) {
        reply.code(404);
        return { error: "session not found" };
      }
      if (session.ended_at === undefined) {
        reply.code(409);
        return { error: "session is still active" };
      }
      // Rows stay pending — the owner chose to leave the worker's backlog for later.
      return { ok: true };
    },
  );
}
