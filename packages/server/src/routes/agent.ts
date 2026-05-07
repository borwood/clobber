import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
import { AgentStatusUpdateSchema } from "@clobber/shared";
import { executeSpawn } from "../spawn-pipeline.ts";
import { terminateSession } from "../session-lifecycle.ts";
import { readTranscript } from "../transcript-reader.ts";
import {
  formatTranscript,
  isValidEntryId,
  parseTranscriptQuery,
  type TranscriptQuery,
} from "../transcript-formatter.ts";
import { resolveCallerSession } from "./_agent-auth.ts";
import { normalizeSpawnLabel } from "./_spawn-label.ts";

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
}

const AgentSpawnBodySchema = z.object({
  role: z.string().min(1),
  prompt: z.string().min(1),
  label: z.string().optional(),
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

  app.get("/agent/agents", async (request, reply) => {
    const auth = resolveCallerSession(request, deps);
    if (!auth.ok) {
      reply.code(auth.status);
      return { error: auth.error };
    }
    const sessions = deps.sessions.listActiveForWorkspace(auth.session.workspace_id);
    const agents = sessions.map((session) => {
      const role = deps.roles.get(session.role_id);
      if (role === null) throw new Error(`role missing for session ${session.id}`);
      const agentRow = session.agent_id === undefined
        ? null
        : deps.agents.get(session.agent_id);
      const live = deps.registry.get(session.id);
      const state: "busy" | "idle" = live === null || live.busy ? "busy" : "idle";
      const entry: Record<string, unknown> = {
        session_id: session.id,
        agent_id: session.agent_id,
        role: { id: role.id, name: role.name },
        pid: session.pid,
        state,
        started_at: session.started_at,
        is_caller: session.id === auth.session.id,
      };
      if (agentRow !== null && agentRow.label !== undefined) {
        entry["label"] = agentRow.label;
      }
      return entry;
    });
    return { agents };
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
    const { role: roleName, prompt } = parsed.data;
    const label = normalizeSpawnLabel(parsed.data.label);
    if (label === null) {
      reply.code(400);
      return { error: "label is required" };
    }

    const workspace = deps.workspaces.get(auth.session.workspace_id);
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

    const result = executeSpawn(deps, {
      workspace,
      role,
      prompt,
      label,
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
  });

  app.get<{ Params: { id: string }; Querystring: TranscriptQuery }>(
    "/agent/sessions/:id/transcript",
    async (request, reply) => {
      const auth = resolveCallerSession(request, deps);
      if (!auth.ok) {
        reply.code(auth.status);
        return { error: auth.error };
      }
      const target = deps.sessions.get(request.params.id);
      if (target === null || target.workspace_id !== auth.session.workspace_id) {
        reply.code(404);
        return { error: "session not found" };
      }
      const parsed = parseTranscriptQuery(request.query);
      if (!parsed.ok) {
        reply.code(400);
        return { error: parsed.error };
      }
      const lines = target.transcript_path === undefined
        ? []
        : await readTranscript(target.transcript_path);
      const sel = parsed.selection;
      if (
        (sel.kind === "entry" || sel.kind === "from" || sel.kind === "to") &&
        !isValidEntryId(sel.id, lines.length)
      ) {
        reply.code(404);
        return { error: `entry id out of range: ${sel.id}` };
      }
      return formatTranscript(lines, sel, parsed.detail);
    },
  );

  app.post("/agent/status", async (request, reply) => {
    const auth = resolveCallerSession(request, deps);
    if (!auth.ok) {
      reply.code(auth.status);
      return { error: auth.error };
    }
    const parsed = AgentStatusUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid status update", issues: parsed.error.issues };
    }
    deps.agentStatuses.upsert({
      session_id: auth.session.id,
      state: parsed.data.state,
      summary: parsed.data.summary,
      ...(parsed.data.details === undefined ? {} : { details: parsed.data.details }),
    });
    // Active sessions always carry agent_id; the FK only nulls it on agent
    // delete, which terminates the session's process before the agent can
    // post status. Type narrowing for an invariant the runtime guarantees.
    const agentId = auth.session.agent_id!;
    deps.agentStatusLog.append({
      agent_id: agentId,
      session_id: auth.session.id,
      kind: "status",
      state: parsed.data.state,
      summary: parsed.data.summary,
      ...(parsed.data.details === undefined ? {} : { details: parsed.data.details }),
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>(
    "/agent/sessions/:id/kill",
    async (request, reply) => {
      const auth = resolveCallerSession(request, deps);
      if (!auth.ok) {
        reply.code(auth.status);
        return { error: auth.error };
      }
      const target = deps.sessions.get(request.params.id);
      if (target === null || target.workspace_id !== auth.session.workspace_id) {
        reply.code(404);
        return { error: "session not found" };
      }
      if (target.ended_at !== undefined) {
        return { ok: true };
      }
      terminateSession(target.id, deps);
      return { ok: true };
    },
  );
}
