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
import { registerAgentMessagesRoutes } from "./routes/agent-messages.ts";
import { createAgentMessageStore } from "./agent-message-store.ts";
import { createNotificationStore } from "./notification-store.ts";
import { createNotificationDispatcher } from "./notification-dispatch.ts";
import { registerAgentRolesRoutes } from "./routes/agent-roles.ts";
import { registerAgentSelfSkillsRoutes } from "./routes/agent-self-skills.ts";
import { registerAgentAskRoutes } from "./routes/agent-ask.ts";
import { registerPersistentAgentsRoutes } from "./routes/persistent-agents.ts";
import { registerWhiteboardRoutes } from "./routes/whiteboard.ts";
import { registerWebhookTriggersRoutes } from "./routes/webhook-triggers.ts";
import { registerLayoutEventRoutes } from "./routes/layout-events.ts";
import { registerWorkspacePromptModuleRoutes } from "./routes/workspace-prompt-modules.ts";
import { createAgentRegistry } from "./agent-registry.ts";
import { createToolTokenStore } from "./tool-token-store.ts";
import type { ToolTokenGateDeps } from "./tool-token-gate.ts";
import { injectPrompt } from "./inject-prompt.ts";
import { registerToolTokenTestRoutes } from "./routes/tool-token-test.ts";
import { createLayoutEventStore } from "./layout-event-store.ts";
import { createTriggerScheduler } from "./trigger-scheduler.ts";
import { createFinalReportConsumer } from "./final-report-consumer.ts";
import { attachSessionToAgent, type SpawnPipelineDeps } from "./spawn-pipeline.ts";
import { ROLE_CONTRACT_MIGRATOR } from "./role-contract-migration.ts";
import { createRoleContractRefusalStore } from "./role-contract-refusal-store.ts";
import { resumeSessionTurn, resumeEndedSession } from "./resume-pipeline.ts";
import { bootServerRoles } from "./boot-server-roles.ts";
import { createSystemClock } from "./clock.ts";
import { createSessionHabitsResolver, runHabitBash } from "./resolve-session-habits.ts";

export type {
  AgentSpawnRequest,
  SpawnedAgentInfo,
  AgentSpawner,
  ServerOptions,
} from "./types.ts";

import type { ServerOptions } from "./types.ts";

export function createServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  // #411 — with logger:false a thrown route error left no server-side trace (a
  // checkout 500 was a black box). Log every uncaught error's stack here; the
  // default error handler still produces the response, so status semantics are
  // unchanged. Known failure modes are mapped to reasoned 4xx upstream.
  app.addHook("onError", async (_request, _reply, error) => {
    console.error("[clobber] uncaught route error:", error);
  });
  const registry = createAgentRegistry();
  const toolTokens = createToolTokenStore(opts.db);
  const layoutEvents =
    opts.layoutEvents === undefined ? createLayoutEventStore() : opts.layoutEvents;
  const clock = opts.clock === undefined ? createSystemClock() : opts.clock;
  // The notification spine (#425): one dispatcher shared by the trigger emitter
  // and the #93 message route so every cross-agent signal lands on one record.
  const notificationDispatcher = createNotificationDispatcher(
    createNotificationStore(opts.db),
    clock,
  );
  const runtimeProvider =
    opts.runtimeProvider === undefined ? claudeRuntimeProvider : opts.runtimeProvider;
  // The #237 contract gate's migration seam, filled by the #238 framework.
  // Defaults to the real forward-only migrator (zero real steps at contract v1,
  // so it still declines every mismatch today); a fork can inject its own.
  const roleContractMigrator =
    opts.roleContractMigrator === undefined
      ? ROLE_CONTRACT_MIGRATOR
      : opts.roleContractMigrator;
  const roleContractRefusals =
    opts.roleContractRefusals === undefined
      ? createRoleContractRefusalStore(opts.db)
      : opts.roleContractRefusals;

  // Boot-time role wiring (before routes): #239 contract sweep + #349 git-as-truth.
  // When a roleContentCache override is injected, skip git materialization so
  // tests can pre-seed the cache without a real role repo (mirrors the
  // roleContractMigrator / roleContractRefusals override pattern).
  const roleEmbodiment = {
    ...bootServerRoles({
      db: opts.db,
      roleRepoDir: opts.roleContentCache !== undefined ? undefined : opts.roleRepoDir,
      workspaces: opts.workspaces,
      workspaceRoles: opts.workspaceRoles,
      roleVersions: opts.roleVersions,
      roleContractRefusals,
      migrator: roleContractMigrator,
    }),
    ...(opts.roleContentCache !== undefined
      ? { roleContentCache: opts.roleContentCache, roleRepoDir: opts.roleRepoDir }
      : {}),
  };

  // Declared before construction so onSessionEnded can reference it without a
  // circular dependency — the scheduler closes over spawnPipelineDeps in turn.
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
    ...roleEmbodiment,
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
    dispatcher: notificationDispatcher,
    attachSession: (input) => attachSessionToAgent(spawnPipelineDeps, input),
    // #385 — the manager's wake path resolves triggers through the commit-pin
    // view, so a git-backed (commit-pinned) manager still registers and wakes.
    ...roleEmbodiment,
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
    runtimeProvider,
    agentStatusLog: opts.agentStatusLog,
    scheduler,
    resolveSessionHabits:
      opts.resolveSessionHabits === undefined
        ? createSessionHabitsResolver({ roles: opts.roles, roleVersions: opts.roleVersions, ...roleEmbodiment })
        : opts.resolveSessionHabits,
    random: opts.habitRandom === undefined ? Math.random : opts.habitRandom,
    runBash: opts.habitRunBash === undefined ? runHabitBash : opts.habitRunBash,
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
  const toolTokenGate: ToolTokenGateDeps = {
    tokens: toolTokens,
    inject: (sessionId, content, tag) => injectPrompt(sessionId, content, injectDeps, tag),
  };
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
    roleContractRefusals: roleContractRefusals,
    roleContractMigrator,
    ...roleEmbodiment,
    runtimeProvider,
    scheduler,
    onSessionEnded,
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
    gate: toolTokenGate,
    layoutEvents,
    onSessionEnded,
    onWorkerDone,
    resumeEnded: (input) => resumeEndedSession(spawnPipelineDeps, input),
    // #385 — the auth gate (whoami/status/report/cycle/sessions…) resolves a
    // commit-pinned role's allow-list through the cache, so these routes don't 500.
    ...roleEmbodiment,
  });
  registerAgentMessagesRoutes(app, {
    ...injectDeps,
    agentStatusLog: opts.agentStatusLog,
    agentMessages: createAgentMessageStore(opts.db),
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
