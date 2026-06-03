import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeProvider } from "@clobber/runtime";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { RoleVersionStore } from "../role-version-store.ts";
import type { RoleContentCache } from "../role-content-cache.ts";
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
  ModelSchema,
} from "@clobber/shared";
import { executeSpawn } from "../spawn-pipeline.ts";
import type { ResumeEndedResult } from "../resume-pipeline.ts";
import { withAgentAuth } from "./_with-agent-auth.ts";
import { normalizeSpawnLabel } from "./_spawn-label.ts";
import { registerAgentSessionRoutes } from "./agent-sessions.ts";
import { registerAgentCycleRoutes } from "./agent-cycle.ts";
import { registerAgentReportsRoutes } from "./agent-reports.ts";
import { listWorkspaceAgents, parseAgentStates } from "./_agents-listing.ts";
import type { ToolTokenGateDeps } from "../tool-token-gate.ts";
import type { LayoutEventStore } from "../layout-event-store.ts";

export interface AgentRouteDeps {
  readonly sessionTokens: SessionTokenStore;
  readonly sessions: SessionStore;
  readonly roles: RoleStore;
  readonly roleVersions: RoleVersionStore;
  // #385 — present iff git-as-truth is configured; the auth gate resolves a
  // commit-pinned role's allow-list through these (shared by cycle + sessions).
  readonly roleContentCache?: RoleContentCache;
  readonly roleRepoDir?: string;
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
  // The shared tool-token gate (#321) and the layout-event bus (#326) — both
  // consumed by `clobber cycle` (#320) via `registerAgentCycleRoutes`.
  readonly gate: ToolTokenGateDeps;
  readonly layoutEvents: LayoutEventStore;
  readonly onSessionEnded: (workspaceId: string, finishedSessionId: string) => void;
  readonly onWorkerDone: (workspaceId: string, finishedSessionId: string) => void;
  readonly resumeEnded: (input: { readonly sessionId: string; readonly prompt: string | undefined }) => Promise<ResumeEndedResult>;
}

const AgentSpawnBodySchema = z.object({
  role: z.string().min(1),
  prompt: z.string().min(1),
  label: z.string().optional(),
  briefing: BriefingPacketSchema.optional(),
  effort: EffortLevelSchema.optional(),
  model: ModelSchema.optional(),
  // The selected opening move (#212); the minimal by-name seam.
  wake_program: z.string().min(1).optional(),
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

  app.get<{ Querystring: { states?: string } }>(
    "/agent/agents",
    withAgentAuth<{ Querystring: { states?: string } }>(
      "agents",
      deps,
      async (request, reply, { session }) => {
        const states = parseAgentStates(request.query.states);
        if (states === "invalid") {
          reply.code(400);
          return { error: "invalid states query (expected busy,idle,ended)" };
        }
        const agents = listWorkspaceAgents(deps, {
          workspaceId: session.workspace_id,
          callerSessionId: session.id,
          states,
        });
        return { agents };
      },
    ),
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
        ...(parsed.data.wake_program === undefined
          ? {}
          : { wakeProgram: parsed.data.wake_program }),
        ...(parsed.data.briefing === undefined
          ? {}
          : { briefing: parsed.data.briefing }),
        ...(parsed.data.effort === undefined
          ? {}
          : { effortOverride: parsed.data.effort }),
        ...(parsed.data.model === undefined
          ? {}
          : { modelOverride: parsed.data.model }),
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

  registerAgentReportsRoutes(app, deps);
  registerAgentSessionRoutes(app, deps);
  registerAgentCycleRoutes(app, deps);
}
