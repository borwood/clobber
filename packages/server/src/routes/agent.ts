import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeProvider } from "@clobber/runtime";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { RoleVersionStore } from "../role-version-store.ts";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { WorkspaceRoleStore } from "../workspace-role-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { AgentStatusStore } from "../agent-status-store.ts";
import type { AgentStatusLogStore } from "../agent-status-log-store.ts";
import type { AgentQuestionStore } from "../agent-question-store.ts";
import type { AgentQuestionWaiter } from "../agent-question-waiter.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import type { AgentSpawner } from "../types.ts";
import {
  AgentStatusUpdateSchema,
  BriefingPacketSchema,
  EffortLevelSchema,
  FinalReportSchema,
  summarizeFinalReport,
} from "@clobber/shared";
import { executeSpawn } from "../spawn-pipeline.ts";
import type { ResumeEndedResult } from "../resume-pipeline.ts";
import { withAgentAuth } from "./_with-agent-auth.ts";
import { normalizeSpawnLabel } from "./_spawn-label.ts";
import { registerAgentSessionRoutes } from "./agent-sessions.ts";

export interface AgentRouteDeps {
  readonly sessionTokens: SessionTokenStore;
  readonly sessions: SessionStore;
  readonly roles: RoleStore;
  readonly roleVersions: RoleVersionStore;
  readonly workspaces: WorkspaceStore;
  readonly workspaceRoles: WorkspaceRoleStore;
  readonly agents: AgentStore;
  readonly agentStatuses: AgentStatusStore;
  readonly agentStatusLog: AgentStatusLogStore;
  readonly agentQuestions: AgentQuestionStore;
  readonly agentQuestionWaiter: AgentQuestionWaiter;
  readonly registry: AgentRegistry;
  readonly spawner: AgentSpawner;
  readonly hookUrl: string;
  readonly apiBase: string;
  readonly cliEntry: string;
  readonly runtimeProvider: RuntimeProvider;
  readonly onSessionEnded: (workspaceId: string, finishedSessionId: string) => void;
  readonly onWorkerDone: (workspaceId: string, finishedSessionId: string) => void;
  readonly resumeEnded: (input: {
    readonly sessionId: string;
    readonly prompt: string | undefined;
  }) => Promise<ResumeEndedResult>;
}

const AgentSpawnBodySchema = z.object({
  role: z.string().min(1),
  prompt: z.string().min(1),
  label: z.string().optional(),
  briefing: BriefingPacketSchema.optional(),
  effort: EffortLevelSchema.optional(),
});

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  app.get(
    "/agent/me",
    withAgentAuth("whoami", deps, async (_request, reply, { session }) => {
      const role = deps.roles.get(session.role_id);
      if (role === null) {
        reply.code(500);
        return { error: "role missing for session" };
      }
      return {
        session_id: session.id,
        workspace_id: session.workspace_id,
        role: { id: role.id, name: role.name },
        started_at: session.started_at,
      };
    }),
  );

  app.get(
    "/agent/agents",
    withAgentAuth("agents", deps, async (_request, _reply, { session }) => {
      const sessions = deps.sessions.listActiveForWorkspace(session.workspace_id);
      const agents = sessions.map((s) => {
        const role = deps.roles.get(s.role_id);
        if (role === null) throw new Error(`role missing for session ${s.id}`);
        const agentRow = s.agent_id === undefined ? null : deps.agents.get(s.agent_id);
        const live = deps.registry.get(s.id);
        const state: "busy" | "idle" = live === null || live.busy ? "busy" : "idle";
        const entry: Record<string, unknown> = {
          session_id: s.id,
          agent_id: s.agent_id,
          role: { id: role.id, name: role.name },
          pid: s.pid,
          state,
          started_at: s.started_at,
          is_caller: s.id === session.id,
        };
        if (agentRow !== null && agentRow.label !== undefined) {
          entry["label"] = agentRow.label;
        }
        return entry;
      });
      return { agents };
    }),
  );

  app.post(
    "/agent/spawn",
    withAgentAuth("spawn", deps, async (request, reply, { session }) => {
      const parsed = AgentSpawnBodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid spawn request", issues: parsed.error.issues };
      }
      const { role: roleName, prompt } = parsed.data;
      const label = normalizeSpawnLabel(parsed.data.label);
      if (label === null) {
        reply.code(400);
        return { error: "label is required" };
      }

      const workspace = deps.workspaces.get(session.workspace_id);
      if (workspace === null) {
        reply.code(500);
        return { error: "workspace missing for session" };
      }
      const role =
        deps.roles.findInWorkspace(workspace.id, roleName) ??
        deps.roles.findByName(roleName);
      if (role === null) {
        reply.code(404);
        return { error: `role not found: ${roleName}` };
      }

      const result = await executeSpawn(deps, {
        workspace,
        role,
        prompt,
        label,
        ...(parsed.data.briefing === undefined
          ? {}
          : { briefing: parsed.data.briefing }),
        ...(parsed.data.effort === undefined
          ? {}
          : { effortOverride: parsed.data.effort }),
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
    }),
  );

  app.post(
    "/agent/status",
    withAgentAuth("status", deps, async (request, reply, { session }) => {
      const parsed = AgentStatusUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid status update", issues: parsed.error.issues };
      }
      deps.agentStatuses.upsert({
        session_id: session.id,
        state: parsed.data.state,
        summary: parsed.data.summary,
        ...(parsed.data.details === undefined ? {} : { details: parsed.data.details }),
      });
      // Active sessions always carry agent_id; the FK only nulls it on agent
      // delete, which terminates the session's process before the agent can
      // post status. Type narrowing for an invariant the runtime guarantees.
      const agentId = session.agent_id!;
      deps.agentStatusLog.append({
        agent_id: agentId,
        session_id: session.id,
        kind: "status",
        state: parsed.data.state,
        summary: parsed.data.summary,
        ...(parsed.data.details === undefined ? {} : { details: parsed.data.details }),
      });
      // A worker's `clobber status done` is its terminal handoff — the manager's
      // work-is-done wake keys on this transition (the worker idles after a PR
      // rather than ending, so session-ended never fires on the happy path). See #240.
      if (parsed.data.state === "done") {
        deps.onWorkerDone(session.workspace_id, session.id);
      }
      return { ok: true };
    }),
  );

  app.post(
    "/agent/report",
    withAgentAuth("report", deps, async (request, reply, { session }) => {
      const parsed = FinalReportSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid final report", issues: parsed.error.issues };
      }
      const agentId = session.agent_id!;
      const existing = deps.agentStatusLog
        .listForAgent(agentId, { kind: "final-report" })
        .filter((row) => row.session_id === session.id);
      if (existing.length > 0) {
        reply.code(409);
        return { error: "final report already submitted for this session" };
      }
      deps.agentStatusLog.append({
        agent_id: agentId,
        session_id: session.id,
        kind: "final-report",
        state: "final",
        summary: summarizeFinalReport(parsed.data),
        details: parsed.data,
      });
      return { ok: true };
    }),
  );

  app.get(
    "/agent/reports",
    withAgentAuth("reports", deps, async (_request, _reply, { session }) => {
      const entries = deps.agentStatusLog.listFinalReportsForWorkspace(
        session.workspace_id,
      );
      const reports = entries.map((entry) => {
        const target = deps.sessions.get(entry.session_id);
        if (target === null) {
          throw new Error(`session missing for final-report ${entry.id}`);
        }
        const role = deps.roles.get(target.role_id);
        if (role === null) {
          throw new Error(`role missing for session ${target.id}`);
        }
        return {
          session_id: entry.session_id,
          role: role.name,
          ...(target.label === undefined ? {} : { label: target.label }),
          state: entry.state,
          summary: entry.summary,
          created_at: entry.created_at,
        };
      });
      return { reports };
    }),
  );

  app.get<{ Params: { id: string } }>(
    "/agent/reports/:id",
    withAgentAuth<{ Params: { id: string } }>(
      "reports",
      deps,
      async (request, reply, { session }) => {
        const target = deps.sessions.get(request.params.id);
        if (target === null || target.workspace_id !== session.workspace_id) {
          reply.code(404);
          return { error: "session not found" };
        }
        const entry = deps.agentStatusLog.latestForSession(
          target.id,
          "final-report",
        );
        if (entry === null) {
          reply.code(404);
          return { error: "no final report for session" };
        }
        const role = deps.roles.get(target.role_id);
        if (role === null) {
          throw new Error(`role missing for session ${target.id}`);
        }
        return {
          session_id: target.id,
          role: role.name,
          ...(target.label === undefined ? {} : { label: target.label }),
          state: entry.state,
          summary: entry.summary,
          created_at: entry.created_at,
          report: entry.details,
        };
      },
    ),
  );

  registerAgentSessionRoutes(app, deps);
}
