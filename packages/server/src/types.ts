import type { PermissionMode } from "@clobber/shared";
import type { EventStore } from "./event-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import type { RoleStore } from "./role-store.ts";
import type { WorkspaceRoleStore } from "./workspace-role-store.ts";
import type { AgentStore } from "./agent-store.ts";
import type { SessionStore } from "./session-store.ts";

export interface AgentSpawnRequest {
  readonly hookUrl: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly permissionMode?: PermissionMode;
  readonly allowedTools?: readonly string[];
}

export interface SpawnedAgentInfo {
  readonly sessionId: string;
  readonly pid: number;
}

export type AgentSpawner = (req: AgentSpawnRequest) => SpawnedAgentInfo;

export interface ServerOptions {
  readonly store: EventStore;
  readonly workspaces: WorkspaceStore;
  readonly roles: RoleStore;
  readonly workspaceRoles: WorkspaceRoleStore;
  readonly agents: AgentStore;
  readonly sessions: SessionStore;
  readonly spawner: AgentSpawner;
  readonly hookUrl: string;
}
