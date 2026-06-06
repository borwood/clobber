import type { FastifyInstance } from "fastify";
import { registerHookRoutes } from "./routes/hooks.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerSpawnRoutes } from "./routes/spawn.ts";
import { registerWorkspaceRoutes } from "./routes/workspaces.ts";
import { registerFsRoutes } from "./routes/fs.ts";
import { registerRoleRoutes } from "./routes/roles.ts";
import { registerWorkspaceRoleRoutes } from "./routes/workspace-roles.ts";
import { registerAgentRoutes } from "./routes/agent.ts";
import { registerAgentMessagesRoutes } from "./routes/agent-messages.ts";
import { registerAgentRolesRoutes } from "./routes/agent-roles.ts";
import { registerAgentSelfSkillsRoutes } from "./routes/agent-self-skills.ts";
import { registerAgentAskRoutes } from "./routes/agent-ask.ts";
import { registerNotificationsRoutes } from "./routes/agent-notifications.ts";
import { registerPersistentAgentsRoutes } from "./routes/persistent-agents.ts";
import { registerWhiteboardRoutes } from "./routes/whiteboard.ts";
import { registerWebhookTriggersRoutes } from "./routes/webhook-triggers.ts";
import { registerLayoutEventRoutes } from "./routes/layout-events.ts";
import { registerToolTokenTestRoutes } from "./routes/tool-token-test.ts";
import { registerWorkspacePromptModuleRoutes } from "./routes/workspace-prompt-modules.ts";
import { registerSessionLocationsRoutes } from "./routes/session-locations.ts";
import type { ServerOptions } from "./types.ts";
import type { ServerDeps } from "./server-deps.ts";

export function registerAllRoutes(
  app: FastifyInstance,
  opts: ServerOptions,
  deps: ServerDeps,
): void {
  const {
    registry,
    runtimeProvider,
    roleEmbodiment,
    scheduler,
    spawnPipelineDeps,
    injectDeps,
    toolTokenGate,
    agentMessages,
    notificationDispatcher,
    layoutEvents,
    resolveSessionHabits,
    random,
    runBash,
    resumeTurn,
    resumeEnded,
    onSessionEnded,
    onWorkerDone,
  } = deps;

  registerHookRoutes(app, {
    store: opts.store,
    sessions: opts.sessions,
    workspaces: opts.workspaces,
    agents: opts.agents,
    roles: opts.roles,
    sessionTokens: opts.sessionTokens,
    agentQuestions: opts.agentQuestions,
    agentQuestionWaiter: opts.agentQuestionWaiter,
    registry,
    runtimeProvider,
    agentStatusLog: opts.agentStatusLog,
    scheduler,
    resolveSessionHabits,
    random,
    runBash,
    ...(opts.askPollWindowMs === undefined ? {} : { askBridgePollWindowMs: opts.askPollWindowMs }),
  });
  registerEventRoutes(app, { store: opts.store });
  registerSessionRoutes(app, {
    sessions: opts.sessions,
    agents: opts.agents,
    roles: opts.roles,
    sessionTokens: opts.sessionTokens,
    summaries: opts.sessionSummaries,
    agentQuestions: opts.agentQuestions,
    agentQuestionWaiter: opts.agentQuestionWaiter,
    registry,
    runtimeProvider,
    resumeTurn,
    resumeEnded,
  });
  registerToolTokenTestRoutes(app, {
    sessionTokens: opts.sessionTokens,
    sessions: opts.sessions,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    agentStatuses: opts.agentStatuses,
    gate: toolTokenGate,
    ...roleEmbodiment,
  });
  registerSpawnRoutes(app, {
    workspaces: opts.workspaces,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    workspaceRoles: opts.workspaceRoles,
    agents: opts.agents,
    sessions: opts.sessions,
    sessionTokens: opts.sessionTokens,
    spawner: opts.spawner,
    hookUrl: opts.hookUrl,
    apiBase: opts.apiBase,
    cliEntry: opts.cliEntry,
    registry,
    agentQuestions: opts.agentQuestions,
    agentQuestionWaiter: opts.agentQuestionWaiter,
    ...roleEmbodiment,
    runtimeProvider,
    scheduler,
    onSessionEnded,
    notifications: deps.notificationStore,
  });
  registerWorkspaceRoutes(app, {
    db: opts.db,
    workspaces: opts.workspaces,
    scheduler,
    // #385 — `roleForks` (present iff a role repo is configured) flips seeding to
    // commit-pins, so a fresh workspace embodies its roles from git by default.
    ...roleEmbodiment,
  });
  registerWebhookTriggersRoutes(app, { scheduler });
  registerLayoutEventRoutes(app, { layoutEvents });
  registerWorkspacePromptModuleRoutes(app, { db: opts.db, workspaces: opts.workspaces });
  registerFsRoutes(app);
  registerSessionLocationsRoutes(app, {
    sessions: opts.sessions,
    agents: opts.agents,
    roles: opts.roles,
    workspaces: opts.workspaces,
  });
  registerPersistentAgentsRoutes(app, {
    workspaces: opts.workspaces,
    agents: opts.agents,
    roles: opts.roles,
    sessions: opts.sessions,
    spawnPipelineDeps,
  });
  registerWhiteboardRoutes(app, {
    workspaces: opts.workspaces,
    agents: opts.agents,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    sessions: opts.sessions,
    registry,
    agentStatuses: opts.agentStatuses,
    ...roleEmbodiment,
  });
  registerRoleRoutes(app, { roles: opts.roles });
  registerWorkspaceRoleRoutes(app, {
    db: opts.db,
    workspaces: opts.workspaces,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    workspaceRoles: opts.workspaceRoles,
    scheduler,
    ...roleEmbodiment,
  });
  registerAgentRoutes(app, {
    sessionTokens: opts.sessionTokens,
    sessions: opts.sessions,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    workspaces: opts.workspaces,
    workspaceRoles: opts.workspaceRoles,
    agents: opts.agents,
    agentStatuses: opts.agentStatuses,
    agentStatusLog: opts.agentStatusLog,
    agentQuestions: opts.agentQuestions,
    agentQuestionWaiter: opts.agentQuestionWaiter,
    registry,
    spawner: opts.spawner,
    hookUrl: opts.hookUrl,
    apiBase: opts.apiBase,
    cliEntry: opts.cliEntry,
    runtimeProvider,
    gate: toolTokenGate,
    layoutEvents,
    store: opts.store,
    sleep: opts.sleep !== undefined
      ? opts.sleep
      : (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
    onSessionEnded,
    onWorkerDone,
    resumeEnded,
    notifications: deps.notificationStore,
    // #385 — the auth gate (whoami/status/report/cycle/sessions…) resolves a
    // commit-pinned role's allow-list through the cache, so these routes don't 500.
    ...roleEmbodiment,
  });
  registerAgentMessagesRoutes(app, {
    ...injectDeps,
    agentStatusLog: opts.agentStatusLog,
    agentMessages,
    dispatcher: notificationDispatcher,
  });
  registerAgentRolesRoutes(app, {
    db: opts.db,
    sessionTokens: opts.sessionTokens,
    sessions: opts.sessions,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    workspaceRoles: opts.workspaceRoles,
    workspaces: opts.workspaces,
    scheduler,
    ...roleEmbodiment,
  });
  registerAgentSelfSkillsRoutes(app, {
    db: opts.db,
    sessionTokens: opts.sessionTokens,
    sessions: opts.sessions,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    workspaces: opts.workspaces,
    agentStatusLog: opts.agentStatusLog,
    scheduler,
    ...roleEmbodiment,
  });
  registerAgentAskRoutes(app, {
    sessionTokens: opts.sessionTokens,
    sessions: opts.sessions,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    agentQuestions: opts.agentQuestions,
    agentQuestionWaiter: opts.agentQuestionWaiter,
    ...(opts.askPollWindowMs === undefined ? {} : { askPollWindowMs: opts.askPollWindowMs }),
    ...roleEmbodiment,
  });
  registerNotificationsRoutes(app, {
    notifications: deps.notificationStore,
    clock: deps.clock,
  });
}
