import type { Database } from "bun:sqlite";
import type { PermissionMode } from "@clobber/shared";
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
import type { AgentQuestionStore } from "./agent-question-store.ts";
import type { AgentQuestionWaiter } from "./agent-question-waiter.ts";
import type { TriggerDispatchStore } from "./trigger-dispatch-store.ts";
import type { Clock } from "./clock.ts";

export interface AgentSpawnRequest {
  readonly hookUrl: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly permissionMode?: PermissionMode;
  readonly allowedTools?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly pluginDirs?: readonly string[];
  readonly appendSystemPrompt?: string;
}

export interface SpawnedAgentInfo {
  readonly sessionId: string;
  readonly pid: number;
  readonly exited: Promise<number | null>;
  readonly stdin: NodeJS.WritableStream;
  readonly kill: (signal: NodeJS.Signals) => void;
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
  readonly agentQuestions: AgentQuestionStore;
  readonly agentQuestionWaiter: AgentQuestionWaiter;
  readonly askTimeoutMs?: number;
  readonly spawner: AgentSpawner;
  readonly hookUrl: string;
  readonly apiBase: string;
  readonly cliEntry: string;
  readonly dispatches: TriggerDispatchStore;
  readonly clock?: Clock;
}
