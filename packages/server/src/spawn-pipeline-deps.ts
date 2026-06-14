import type { RuntimeProvider } from "@clobber/runtime";
import type { Agent, Role, Workspace } from "@clobber/shared";
import type { WorkspaceRoleStore } from "./workspace-role-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import type { AgentStore } from "./agent-store.ts";
import type { SessionStore } from "./session-store.ts";
import type { SessionTokenStore } from "./session-token-store.ts";
import type { AgentSpawner } from "./types.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { RoleStore } from "./role-store.ts";
import type { RoleVersionStore } from "./role-version-store.ts";
import type { AgentQuestionStore } from "./agent-question-store.ts";
import type { AgentQuestionWaiter } from "./agent-question-waiter.ts";
import type { NotificationStore } from "./notification-store.ts";
import type { RoleContentCache } from "./role-content-cache.ts";

export interface SpawnPipelineDeps {
  readonly workspaces: WorkspaceStore;
  readonly workspaceRoles: WorkspaceRoleStore;
  readonly agents: AgentStore;
  readonly sessions: SessionStore;
  readonly sessionTokens: SessionTokenStore;
  readonly spawner: AgentSpawner;
  readonly hookUrl: string;
  readonly apiBase: string;
  readonly cliEntry: string;
  readonly registry: AgentRegistry;
  readonly roles: RoleStore;
  readonly roleVersions: RoleVersionStore;
  // #349 git-as-truth — present when the upstream role repo is materialized
  // (boot wires it). Embodiment reads commit-pinned roles through the cache;
  // a commit pin with these absent is a misconfiguration (embodyRole throws).
  readonly roleContentCache?: RoleContentCache;
  readonly roleRepoDir?: string;
  readonly runtimeProvider: RuntimeProvider;
  readonly agentQuestions: AgentQuestionStore;
  readonly agentQuestionWaiter: AgentQuestionWaiter;
  // Fired once, on the reaper call that actually transitions a session to
  // ended, so a crash / non-zero exit (where no SessionEnd hook arrives) still
  // wakes a manager declaring a `session-ended` trigger. Injected late by the
  // server to break the spawn-pipeline ↔ scheduler construction cycle.
  readonly onSessionEnded: (workspaceId: string, finishedSessionId: string) => void;
  // Phase-2 boot re-dump: un-acked notifications surface in the agent's system
  // prompt on every wake (persistent agents only, non-flushing).
  readonly notifications: NotificationStore;
  readonly installTimeoutMs?: number; // test seam: override bun install timeout
}
