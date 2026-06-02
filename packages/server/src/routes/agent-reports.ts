import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FinalReportSchema, summarizeFinalReport } from "@clobber/shared";
import { withAgentAuth } from "./_with-agent-auth.ts";
import type { AgentRouteDeps } from "./agent.ts";

/**
 * Routes for the triage-drop and triage-read surfaces:
 *   POST /agent/finding  — repeatable append-many observation (#167)
 *   POST /agent/report   — once-per-session final report
 *   GET  /agent/reports  — triage reader: findings + final-reports, labeled by kind
 *   GET  /agent/reports/:id — full structured detail for one session's report
 *
 * Split out of agent.ts to keep both files under the 300-line ceiling.
 */
export function registerAgentReportsRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps,
): void {
  app.post(
    "/agent/finding",
    withAgentAuth("finding", deps, async (request, reply, { session }) => {
      const parsed = z.object({ summary: z.string().min(1) }).safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid finding request", issues: parsed.error.issues };
      }
      const agentId = session.agent_id!;
      deps.agentStatusLog.append({
        agent_id: agentId,
        session_id: session.id,
        kind: "finding",
        state: "finding",
        summary: parsed.data.summary,
      });
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
      const entries = deps.agentStatusLog.listFindingsAndReportsForWorkspace(
        session.workspace_id,
      );
      const reports = entries.map((entry) => {
        const target = deps.sessions.get(entry.session_id);
        if (target === null) {
          throw new Error(`session missing for log entry ${entry.id}`);
        }
        const role = deps.roles.get(target.role_id);
        if (role === null) {
          throw new Error(`role missing for session ${target.id}`);
        }
        return {
          kind: entry.kind,
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
}
