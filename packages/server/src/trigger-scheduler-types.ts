import type { RoleTrigger } from "@clobber/shared";
import type { AgentBinding, DispatchResult } from "./trigger-dispatch.ts";

// A completion-wake fire entry point: wakes persistent agents in the workspace
// declaring the corresponding kind for the finished session.
export type FireCompletionWake = (
  workspaceId: string,
  finishedSessionId: string,
) => Promise<DispatchResult>;

// The two in-memory index entry shapes the scheduler keeps for the live event
// sources it owns directly (cron + completion-wakes live in their own
// sub-schedulers). Kept beside the scheduler engine, separate from it.
export interface ScheduledWebhook extends AgentBinding {
  readonly trigger: { kind: "webhook"; path: string };
}

export interface ScheduledWorkspaceOpen extends AgentBinding {
  readonly trigger: { kind: "workspace-open"; debounce_ms?: number | undefined };
  readonly debounceMs: number;
  lastFiredAt: number | null;
}

// Declared-but-never-fired trigger kinds: they have no live event source, so
// the scheduler records them as unsupported-kind rather than wiring them up.
export const UNSUPPORTED_KINDS: ReadonlySet<RoleTrigger["kind"]> = new Set([
  "file-watch",
  "issue-assigned",
]);

export const DEFAULT_WORKSPACE_OPEN_DEBOUNCE_MS = 10_000;
