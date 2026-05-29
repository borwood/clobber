import type { Database } from "bun:sqlite";
import type {
  RuntimeEvent,
  RuntimeProvider,
  RuntimeSpawnRequest,
  RuntimeStartupResult,
} from "@clobber/runtime";
import type { EventStore } from "./event-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import type { RoleStore } from "./role-store.ts";
import type { RoleVersionStore } from "./role-version-store.ts";
import type { WorkspaceRoleStore } from "./workspace-role-store.ts";
import type { AgentStore } from "./agent-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { WorkspaceSessionSummaries } from "./workspace-session-summaries.ts";
import type { SessionTokenStore } from "./session-token-store.ts";
import type { AgentStatusStore } from "./agent-status-store.ts";
import type { AgentStatusLogStore } from "./agent-status-log-store.ts";
import type { RoleContractMigrator } from "./role-contract-compat.ts";
import type { RoleContractRefusalStore } from "./role-contract-refusal-store.ts";
import type { AgentQuestionStore } from "./agent-question-store.ts";
import type { AgentQuestionWaiter } from "./agent-question-waiter.ts";
import type { TriggerDispatchStore } from "./trigger-dispatch-store.ts";
import type { FinalReportConsumerStateStore } from "./final-report-consumer.ts";
import type { LayoutEventStore } from "./layout-event-store.ts";
import type { Clock } from "./clock.ts";

export type AgentSpawnRequest = RuntimeSpawnRequest;

export interface SpawnedAgentInfo {
  readonly sessionId: string;
  readonly pid: number;
  readonly exited: Promise<number | null>;
  readonly stdin: NodeJS.WritableStream;
  readonly kill: (signal: NodeJS.Signals) => void;
  readonly runtimeEvents?: AsyncIterable<RuntimeEvent>;
  readonly startup?: Promise<RuntimeStartupResult>;
}

export type AgentSpawner = (req: AgentSpawnRequest) => SpawnedAgentInfo;

export interface ServerOptions {
  readonly db: Database;
  readonly store: EventStore;
  readonly workspaces: WorkspaceStore;
  readonly roles: RoleStore;
  readonly roleVersions: RoleVersionStore;
  readonly workspaceRoles: WorkspaceRoleStore;
  readonly agents: AgentStore;
  readonly sessions: SessionStore;
  readonly sessionSummaries: WorkspaceSessionSummaries;
  readonly sessionTokens: SessionTokenStore;
  readonly agentStatuses: AgentStatusStore;
  readonly agentStatusLog: AgentStatusLogStore;
  // The #237 contract-gate refusal sink. Optional with an internal default
  // (constructed from `db`) so existing callers are untouched.
  readonly roleContractRefusals?: RoleContractRefusalStore;
  readonly agentQuestions: AgentQuestionStore;
  readonly agentQuestionWaiter: AgentQuestionWaiter;
  readonly askTimeoutMs?: number;
  // The #237 contract-gate migration seam. Optional with an internal default
  // (the empty migrator) so existing callers are untouched; #238 / a fork can
  // inject a populated one.
  readonly roleContractMigrator?: RoleContractMigrator;
  readonly runtimeProvider?: RuntimeProvider;
  readonly spawner: AgentSpawner;
  readonly hookUrl: string;
  readonly apiBase: string;
  readonly cliEntry: string;
  readonly dispatches: TriggerDispatchStore;
  readonly finalReportConsumerState: FinalReportConsumerStateStore;
  // Transient server→web layout bus (#326). Optional with an internal default so
  // existing callers are untouched; the producer seam (`emit`) is reached from
  // inside the server by future consumers (#320 cycle, #246 sticky tabs).
  readonly layoutEvents?: LayoutEventStore;
  readonly clock?: Clock;
}
