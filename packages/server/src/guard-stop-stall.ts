import { z } from "zod";
import type { StopPayload } from "@clobber/shared";
import type { SessionStore } from "./session-store.ts";
import type { RoleStore } from "./role-store.ts";
import type { AgentStatusLogStore } from "./agent-status-log-store.ts";

const TaskSnapshotItemSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});

export const STOP_STALL_REASON =
  "phase plan incomplete — continue working or post a blocked report before stopping";

export interface StopDenial {
  readonly decision: "block";
  readonly reason: string;
}

export interface StopStallGuardDeps {
  readonly sessions: SessionStore;
  readonly roles: RoleStore;
  readonly agentStatusLog: AgentStatusLogStore;
}

export interface StopStallLatch {
  has(sessionId: string): boolean;
  mark(sessionId: string): void;
}

export function guardStopStall(
  payload: StopPayload,
  deps: StopStallGuardDeps,
  latch: StopStallLatch,
): StopDenial | null {
  const session = deps.sessions.get(payload.session_id);
  if (session === null || session.agent_id === undefined) return null;

  const role = deps.roles.get(session.role_id);
  if (role === null || role.persistent) return null;

  if (latch.has(payload.session_id)) return null;

  const hasPendingTasks = readHasPendingTasks(deps.agentStatusLog, session.agent_id);
  if (!hasPendingTasks) return null;

  const report = deps.agentStatusLog.latestForSession(payload.session_id, "final-report");
  if (report !== null) return null;

  latch.mark(payload.session_id);
  return { decision: "block", reason: STOP_STALL_REASON };
}

function readHasPendingTasks(store: AgentStatusLogStore, agentId: string): boolean {
  const entries = store.listForAgent(agentId, { kind: "task-snapshot", limit: 1 });
  if (entries.length === 0) return false;
  const details = entries[0]!.details;
  if (details === null) return false;
  const parsed = z.object({ tasks: z.array(TaskSnapshotItemSchema) }).safeParse(details);
  if (!parsed.success) return false;
  return parsed.data.tasks.some((t) => t.status === "pending" || t.status === "in_progress");
}
