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
import { createAgentRegistry } from "./agent-registry.ts";
import { createTriggerScheduler } from "./trigger-scheduler.ts";
import { createFinalReportConsumer } from "./final-report-consumer.ts";
import {
  attachSessionToAgent,
  resumeSessionTurn,
  type SpawnPipelineDeps,
} from "./spawn-pipeline.ts";
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
  const clock = opts.clock === undefined ? createSystemClock() : opts.clock;
  const runtimeProvider =
    opts.runtimeProvider === undefined ? claudeRuntimeProvider : opts.runtimeProvider;

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
  };

  const scheduler = createTriggerScheduler({
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
    runtimeProvider,
    scheduler,
  });
  registerWorkspaceRoutes(app, {
    db: opts.db,
    workspaces: opts.workspaces,
    scheduler,
  });
  registerWebhookTriggersRoutes(app, { scheduler });
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
    agentQuestions: opts.agentQuestions,
    agentQuestionWaiter: opts.agentQuestionWaiter,
    registry,
    spawner: opts.spawner,
    hookUrl: opts.hookUrl,
    apiBase: opts.apiBase,
    cliEntry: opts.cliEntry,
    runtimeProvider,
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
