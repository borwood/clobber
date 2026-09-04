import type { FastifyInstance } from "fastify";
import type { FinalReport } from "@clobber/shared";
import type { WorkspaceStore } from "../workspace-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { AgentStatusLogStore } from "../agent-status-log-store.ts";

interface IdParam {
  id: string;
}

interface ReportEntry {
  session_id: string;
  role: string;
  label?: string;
  summary: string;
  created_at: number;
  report: FinalReport;
}

export interface WorkspaceReportsRouteDeps {
  readonly workspaces: WorkspaceStore;
  readonly sessions: SessionStore;
  readonly roles: RoleStore;
  readonly agentStatusLog: AgentStatusLogStore;
}

// Web-facing counterpart to the agent-token-authed /agent/reports family
// (agent-reports.ts) — same underlying data (agentStatusLog kind
// "final-report"), unauthenticated and workspace-scoped like whiteboard.ts,
// so the browser can render it (#691).
export function registerWorkspaceReportsRoutes(
  app: FastifyInstance,
  deps: WorkspaceReportsRouteDeps,
): void {
  const { workspaces, sessions, roles, agentStatusLog } = deps;

  app.get<{ Params: IdParam }>(
    "/workspaces/:id/reports",
    async (request, reply) => {
      const workspace = workspaces.get(request.params.id);
      if (workspace === null) {
        reply.code(404);
        return { error: "workspace not found" };
      }

      const entries = agentStatusLog.listFinalReportsForWorkspace(workspace.id);
      const reports: ReportEntry[] = entries.map((entry) => {
        const target = sessions.get(entry.session_id);
        if (target === null) {
          throw new Error(`session missing for log entry ${entry.id}`);
        }
        const role = roles.get(target.role_id);
        if (role === null) {
          throw new Error(`role missing for session ${target.id}`);
        }
        return {
          session_id: entry.session_id,
          role: role.name,
          ...(target.label === undefined ? {} : { label: target.label }),
          summary: entry.summary,
          created_at: entry.created_at,
          report: entry.details as FinalReport,
        };
      });
      return { reports };
    },
  );
}
