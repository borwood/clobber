import type { PermissionMode } from "@clobber/shared";
import type { EventStore } from "./event-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import type { RoleStore } from "./role-store.ts";
import type { WorkspaceRoleStore } from "./workspace-role-store.ts";
import type { AgentStore } from "./agent-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { WorkspaceSessionSummaries } from "./workspace-session-summaries.ts";
import type { SessionTokenStore } from "./session-token-store.ts";

export interface AgentSpawnRequest {
  readonly hookUrl: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly permissionMode?: PermissionMode;
  readonly allowedTools?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: Record<string, unknown>;
}

export interface SpawnedAgentInfo {
  readonly sessionId: string;
  readonly pid: number;
  readonly exited: Promise<number | null>;
  readonly stdin: NodeJS.WritableStream;
}

export type AgentSpawner = (req: AgentSpawnRequest) => SpawnedAgentInfo;

export interface ServerOptions {
  readonly store: EventStore;
  readonly workspaces: WorkspaceStore;
  readonly roles: RoleStore;
  readonly workspaceRoles: WorkspaceRoleStore;
  readonly agents: AgentStore;
  readonly sessions: SessionStore;
  readonly sessionSummaries: WorkspaceSessionSummaries;
  readonly sessionTokens: SessionTokenStore;
  readonly spawner: AgentSpawner;
  readonly hookUrl: string;
  readonly apiBase: string;
  readonly cliEntry: string;
}
