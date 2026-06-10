import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SessionStore } from "../session-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { WorkspaceStore } from "../workspace-store.ts";
import { rearmPending, type RearmPendingDeps } from "../notification-rearm.ts";
import { attachSessionToAgent, type SpawnPipelineDeps } from "../spawn-pipeline.ts";
import type { ResumeEndedResult } from "../resume-pipeline.ts";
import type { AgentMessageStore } from "../agent-message-store.ts";

interface IdParam {
  id: string;
}

const ResumeBodySchema = z.object({ token: z.string().min(1) });

export interface SessionResumeRouteDeps {
  readonly sessions: SessionStore;
  readonly agents: AgentStore;
  readonly roles: RoleStore;
  readonly workspaces: WorkspaceStore;
  readonly spawnPipelineDeps: SpawnPipelineDeps;
  readonly rearmDeps: RearmPendingDeps;
  readonly agentMessages: AgentMessageStore;
  readonly resumeEnded: (input: {
    readonly sessionId: string;
    readonly prompt: string | undefined;
  }) => Promise<ResumeEndedResult>;
}

function validateToken(
  deps: SessionResumeRouteDeps,
  sessionId: string,
  rawBody: unknown,
): { token: string } | { error: string; status: number } {
  const parsed = ResumeBodySchema.safeParse(rawBody);
  if (!parsed.success) return { error: "token required", status: 403 };
  const { token } = parsed.data;
  const row = deps.agentMessages.get(token);
  if (row === null || row.originator_session_id !== sessionId) return { error: "invalid token", status: 403 };
  if (row.redeemed_at !== null) return { error: "token already used", status: 403 };
  return { token };
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

      const tokenResult = validateToken(deps, sessionId, request.body);
      if ("error" in tokenResult) {
        reply.code(tokenResult.status);
        return { error: tokenResult.error };
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

      // Consume the token before mutating state so a retry with the same token
      // is rejected even if the spawn below fails (prevents double-resume).
      deps.agentMessages.redeem(tokenResult.token);

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

      const tokenResult = validateToken(deps, sessionId, request.body);
      if ("error" in tokenResult) {
        reply.code(tokenResult.status);
        return { error: tokenResult.error };
      }
      deps.agentMessages.redeem(tokenResult.token);

      // Rows stay pending — the owner chose to leave the worker's backlog for later.
      return { ok: true };
    },
  );
}
