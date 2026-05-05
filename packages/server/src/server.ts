import Fastify, { type FastifyInstance } from "fastify";
import { registerHookRoutes } from "./routes/hooks.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerSpawnRoutes } from "./routes/spawn.ts";
import { registerWorkspaceRoutes } from "./routes/workspaces.ts";
import { registerRoleRoutes } from "./routes/roles.ts";
import { registerWorkspaceRoleRoutes } from "./routes/workspace-roles.ts";
import { registerAgentRoutes } from "./routes/agent.ts";
import { registerAgentRolesRoutes } from "./routes/agent-roles.ts";
import { registerAgentAskRoutes } from "./routes/agent-ask.ts";
import { registerPersistentAgentsRoutes } from "./routes/persistent-agents.ts";
import { createAgentRegistry } from "./agent-registry.ts";
import { createTriggerScheduler } from "./trigger-scheduler.ts";
import { attachSessionToAgent, type SpawnPipelineDeps } from "./spawn-pipeline.ts";
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

  const spawnPipelineDeps: SpawnPipelineDeps = {
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
    dispatches: opts.dispatches,
    attachSession: (input) => attachSessionToAgent(spawnPipelineDeps, input),
  });

  registerHookRoutes(app, {
    store: opts.store,
    sessions: opts.sessions,
    agents: opts.agents,
    roles: opts.roles,
    sessionTokens: opts.sessionTokens,
    agentQuestions: opts.agentQuestions,
    agentQuestionWaiter: opts.agentQuestionWaiter,
    registry,
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
    scheduler,
  });
  registerWorkspaceRoutes(app, {
    db: opts.db,
    workspaces: opts.workspaces,
  });
  registerPersistentAgentsRoutes(app, {
    workspaces: opts.workspaces,
    agents: opts.agents,
    roles: opts.roles,
    sessions: opts.sessions,
    registry,
    agentStatuses: opts.agentStatuses,
    spawnPipelineDeps,
  });
  registerRoleRoutes(app, { roles: opts.roles });
  registerWorkspaceRoleRoutes(app, {
    workspaces: opts.workspaces,
    roles: opts.roles,
    workspaceRoles: opts.workspaceRoles,
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
    agentQuestions: opts.agentQuestions,
    agentQuestionWaiter: opts.agentQuestionWaiter,
    registry,
    spawner: opts.spawner,
    hookUrl: opts.hookUrl,
    apiBase: opts.apiBase,
    cliEntry: opts.cliEntry,
  });
  registerAgentRolesRoutes(app, {
    db: opts.db,
    sessionTokens: opts.sessionTokens,
    sessions: opts.sessions,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    workspaceRoles: opts.workspaceRoles,
    scheduler,
  });
  registerAgentAskRoutes(app, {
    sessionTokens: opts.sessionTokens,
    sessions: opts.sessions,
    agentQuestions: opts.agentQuestions,
    agentQuestionWaiter: opts.agentQuestionWaiter,
    ...(opts.askTimeoutMs === undefined ? {} : { askTimeoutMs: opts.askTimeoutMs }),
  });

  scheduler.start();
  app.addHook("onClose", async () => {
    scheduler.stop();
  });

  return app;
}
