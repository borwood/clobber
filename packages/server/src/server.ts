import Fastify, { type FastifyInstance } from "fastify";
import { claudeRuntimeProvider } from "@clobber/runtime";
import { registerHookRoutes } from "./routes/hooks.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerSpawnRoutes } from "./routes/spawn.ts";
import { registerWorkspaceRoutes } from "./routes/workspaces.ts";
import { registerFsRoutes } from "./routes/fs.ts";
import { registerRoleRoutes } from "./routes/roles.ts";
import { registerWorkspaceRoleRoutes } from "./routes/workspace-roles.ts";
import { registerAgentRoutes } from "./routes/agent.ts";
import { registerAgentRolesRoutes } from "./routes/agent-roles.ts";
import { registerAgentSelfSkillsRoutes } from "./routes/agent-self-skills.ts";
import { registerAgentAskRoutes } from "./routes/agent-ask.ts";
import { registerPersistentAgentsRoutes } from "./routes/persistent-agents.ts";
import { registerWhiteboardRoutes } from "./routes/whiteboard.ts";
import { registerWebhookTriggersRoutes } from "./routes/webhook-triggers.ts";
import { registerLayoutEventRoutes } from "./routes/layout-events.ts";
import { createAgentRegistry } from "./agent-registry.ts";
import { createToolTokenStore } from "./tool-token-store.ts";
import { injectPrompt } from "./inject-prompt.ts";
import { registerToolTokenTestRoutes } from "./routes/tool-token-test.ts";
import { createLayoutEventStore } from "./layout-event-store.ts";
import { createTriggerScheduler } from "./trigger-scheduler.ts";
import { createFinalReportConsumer } from "./final-report-consumer.ts";
import { attachSessionToAgent, type SpawnPipelineDeps } from "./spawn-pipeline.ts";
import { ROLE_CONTRACT_MIGRATOR } from "./role-contract-migration.ts";
import { createRoleContractRefusalStore } from "./role-contract-refusal-store.ts";
import { resumeSessionTurn, resumeEndedSession } from "./resume-pipeline.ts";
import { createSystemClock } from "./clock.ts";

export type {
  AgentSpawnRequest,
  SpawnedAgentInfo,
  AgentSpawner,
  ServerOptions,
} from "./types.ts";

import type { ServerOptions } from "./types.ts";

export function createServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const registry = createAgentRegistry();
  const toolTokens = createToolTokenStore(opts.db);
  const layoutEvents =
    opts.layoutEvents === undefined ? createLayoutEventStore() : opts.layoutEvents;
  const clock = opts.clock === undefined ? createSystemClock() : opts.clock;
  const runtimeProvider =
    opts.runtimeProvider === undefined ? claudeRuntimeProvider : opts.runtimeProvider;
  // The #237 contract gate's migration seam, filled by the #238 framework.
  // Defaults to the real forward-only migrator (zero real steps at contract v1,
  // so it still declines every mismatch today); a fork can inject its own
  // migrator without touching the spawn boundary.
  const roleContractMigrator =
    opts.roleContractMigrator === undefined
      ? ROLE_CONTRACT_MIGRATOR
      : opts.roleContractMigrator;
  const roleContractRefusals =
    opts.roleContractRefusals === undefined
      ? createRoleContractRefusalStore(opts.db)
      : opts.roleContractRefusals;

  // Declared before construction so the spawn-pipeline's onSessionEnded can
  // reference it without a circular dependency — the scheduler in turn closes
  // over spawnPipelineDeps for attachSession. Both resolve by call time.
  let scheduler: ReturnType<typeof createTriggerScheduler>;
  const onSessionEnded = (workspaceId: string, finishedSessionId: string): void => {
    void scheduler.fireSessionEnded(workspaceId, finishedSessionId);
  };
  const onWorkerDone = (workspaceId: string, finishedSessionId: string): void => {
    void scheduler.fireWorkerDone(workspaceId, finishedSessionId);
  };

  const spawnPipelineDeps: SpawnPipelineDeps = {
    workspaces: opts.workspaces,
    workspaceRoles: opts.workspaceRoles,
    agents: opts.agents,
    sessions: opts.sessions,
    sessionTokens: opts.sessionTokens,
    spawner: opts.spawner,
    hookUrl: opts.hookUrl,
    apiBase: opts.apiBase,
    cliEntry: opts.cliEntry,
    registry,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    runtimeProvider,
    agentQuestions: opts.agentQuestions,
    agentQuestionWaiter: opts.agentQuestionWaiter,
    roleContractRefusals: roleContractRefusals,
    roleContractMigrator,
    onSessionEnded,
  };

  scheduler = createTriggerScheduler({
    db: opts.db,
    clock,
    workspaces: opts.workspaces,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    agents: opts.agents,
    sessions: opts.sessions,
    registry,
    runtimeProvider,
    dispatches: opts.dispatches,
    agentStatusLog: opts.agentStatusLog,
    attachSession: (input) => attachSessionToAgent(spawnPipelineDeps, input),
  });

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
    agentStatusLog: opts.agentStatusLog,
    scheduler,
    ...(opts.askTimeoutMs === undefined ? {} : { askBridgeTimeoutMs: opts.askTimeoutMs }),
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
    resumeTurn: (input) => resumeSessionTurn(spawnPipelineDeps, input),
    resumeEnded: (input) => resumeEndedSession(spawnPipelineDeps, input),
  });
  // The tool-token primitive's first consumer (#321). The gate injects the
  // repercussion brief into the bearer's transcript via the same `injectPrompt`
  // path the session routes use; saved args replay on redemption.
  const injectDeps = {
    ...spawnPipelineDeps,
    resumeTurn: (input: { sessionId: string; prompt: string }) =>
      resumeSessionTurn(spawnPipelineDeps, input),
  };
  registerToolTokenTestRoutes(app, {
    sessionTokens: opts.sessionTokens,
    sessions: opts.sessions,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    agentStatuses: opts.agentStatuses,
    gate: {
      tokens: toolTokens,
      inject: (sessionId, content, tag) =>
        injectPrompt(sessionId, content, injectDeps, tag),
    },
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
    roleContractRefusals: roleContractRefusals,
    roleContractMigrator,
    runtimeProvider,
    scheduler,
    onSessionEnded,
  });
  registerWorkspaceRoutes(app, {
    db: opts.db,
    workspaces: opts.workspaces,
    scheduler,
  });
  registerWebhookTriggersRoutes(app, { scheduler });
  registerLayoutEventRoutes(app, { layoutEvents });
  registerFsRoutes(app);
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
  });
  registerRoleRoutes(app, { roles: opts.roles });
  registerWorkspaceRoleRoutes(app, {
    db: opts.db,
    workspaces: opts.workspaces,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    workspaceRoles: opts.workspaceRoles,
    scheduler,
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
    roleContractRefusals: roleContractRefusals,
    roleContractMigrator,
    agentQuestions: opts.agentQuestions,
    agentQuestionWaiter: opts.agentQuestionWaiter,
    registry,
    spawner: opts.spawner,
    hookUrl: opts.hookUrl,
    apiBase: opts.apiBase,
    cliEntry: opts.cliEntry,
    runtimeProvider,
    gate: {
      tokens: toolTokens,
      inject: (sessionId, content, tag) =>
        injectPrompt(sessionId, content, injectDeps, tag),
    },
    layoutEvents,
    onSessionEnded,
    onWorkerDone,
    resumeEnded: (input) => resumeEndedSession(spawnPipelineDeps, input),
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
  });
  registerAgentSelfSkillsRoutes(app, {
    db: opts.db,
    sessionTokens: opts.sessionTokens,
    sessions: opts.sessions,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    workspaces: opts.workspaces,
    agentStatusLog: opts.agentStatusLog,
  });
  registerAgentAskRoutes(app, {
    sessionTokens: opts.sessionTokens,
    sessions: opts.sessions,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    agentQuestions: opts.agentQuestions,
    agentQuestionWaiter: opts.agentQuestionWaiter,
    ...(opts.askTimeoutMs === undefined ? {} : { askTimeoutMs: opts.askTimeoutMs }),
  });

  const finalReportConsumer = createFinalReportConsumer({
    db: opts.db,
    workspaces: opts.workspaces,
    agentStatusLog: opts.agentStatusLog,
    stateStore: opts.finalReportConsumerState,
    clock,
  });

  scheduler.start();
  finalReportConsumer.start();
  app.addHook("onClose", async () => {
    scheduler.stop();
    finalReportConsumer.stop();
  });

  return app;
}
