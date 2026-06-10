import type { Database } from "bun:sqlite";
import type { RuntimeProvider } from "@clobber/runtime";
import type { RoleTrigger } from "@clobber/shared";
import type { Clock } from "./clock.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import type { RoleStore } from "./role-store.ts";
import type { RoleVersionStore } from "./role-version-store.ts";
import type { RoleContentCache } from "./role-content-cache.ts";
import type { AgentStore } from "./agent-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { TriggerDispatchStore } from "./trigger-dispatch-store.ts";
import type { AgentStatusLogStore } from "./agent-status-log-store.ts";
import type { AttachSessionFn } from "./trigger-attach.ts";
import type { NotificationDispatcher, ResumeSessionFn } from "./notification-dispatch.ts";
import type { AgentBinding, DispatchResult } from "./trigger-dispatch.ts";

// A completion-wake fire entry point: wakes persistent agents in the workspace
// declaring the corresponding kind for the finished session. completionId pins
// the status/report log row id captured at the route so buildItem never re-fetches
// a different row under a race (#620 HIGH fix).
export type FireCompletionWake = (
  workspaceId: string,
  finishedSessionId: string,
  completionId?: number,
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

export interface TriggerSchedulerDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly workspaces: WorkspaceStore;
  readonly roles: RoleStore;
  readonly roleVersions: RoleVersionStore;
  readonly agents: AgentStore;
  readonly sessions: SessionStore;
  readonly registry: AgentRegistry;
  readonly runtimeProvider: RuntimeProvider;
  readonly dispatches: TriggerDispatchStore;
  readonly agentStatusLog: AgentStatusLogStore;
  readonly attachSession: AttachSessionFn;
  readonly resumeEndedSession: ResumeSessionFn;
  // The notification spine the trigger emitter records onto; defaulted from the
  // scheduler's own db+clock when a caller doesn't share one.
  readonly dispatcher?: NotificationDispatcher;
  readonly synthesizePrompt?: (trigger: RoleTrigger, payload: unknown) => string;
  // #385 — present iff git-as-truth is configured. The manager's wake path
  // resolves its triggers through these, so a commit-pinned manager still wakes.
  readonly roleContentCache?: RoleContentCache;
  readonly roleRepoDir?: string;
}

export interface TriggerScheduler {
  start(): void;
  stop(): void;
  reloadRole(roleId: string): void;
  reloadAgent(agentId: string): void;
  fireWebhook(path: string, payload: unknown): Promise<DispatchResult>;
  fireWorkspaceOpen(workspaceId: string, payload: unknown): Promise<DispatchResult>;
  fireSessionEnded: FireCompletionWake;
  fireWorkerDone: FireCompletionWake;
  flushPendingWakes(agentId: string): Promise<void>;
  // Awaits all in-flight cron dispatch promises. Tests use this after advancing
  // a TestClock to deterministically settle async compose pipelines without
  // fixed sleeps — mirrors the awaitable pattern of fireWebhook/fireWorkspaceOpen.
  drainCronDispatches(): Promise<void>;
}
