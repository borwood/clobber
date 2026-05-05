import Fastify, { type FastifyInstance } from "fastify";
import { registerHookRoutes } from "./routes/hooks.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerSpawnRoutes } from "./routes/spawn.ts";
import { registerWorkspaceRoutes } from "./routes/workspaces.ts";
import { registerRoleRoutes } from "./routes/roles.ts";
import { registerWorkspaceRoleRoutes } from "./routes/workspace-roles.ts";
import { registerAgentRoutes } from "./routes/agent.ts";
import { registerAgentAskRoutes } from "./routes/agent-ask.ts";
import { createAgentRegistry } from "./agent-registry.ts";

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
  });
  registerWorkspaceRoutes(app, {
    workspaces: opts.workspaces,
    roles: opts.roles,
    workspaceRoles: opts.workspaceRoles,
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
  registerAgentAskRoutes(app, {
    sessionTokens: opts.sessionTokens,
    sessions: opts.sessions,
    agentQuestions: opts.agentQuestions,
    agentQuestionWaiter: opts.agentQuestionWaiter,
    ...(opts.askTimeoutMs === undefined ? {} : { askTimeoutMs: opts.askTimeoutMs }),
  });

  return app;
}
