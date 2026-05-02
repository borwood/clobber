import Fastify, { type FastifyInstance } from "fastify";
import { registerHookRoutes } from "./routes/hooks.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerSpawnRoutes } from "./routes/spawn.ts";
import { registerWorkspaceRoutes } from "./routes/workspaces.ts";
import { registerRoleRoutes } from "./routes/roles.ts";
import { registerWorkspaceRoleRoutes } from "./routes/workspace-roles.ts";

export type {
  AgentSpawnRequest,
  SpawnedAgentInfo,
  AgentSpawner,
  ServerOptions,
} from "./types.ts";

import type { ServerOptions } from "./types.ts";

export function createServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  registerHookRoutes(app, { store: opts.store });
  registerEventRoutes(app, { store: opts.store });
  registerSessionRoutes(app, { store: opts.store });
  registerSpawnRoutes(app, {
    workspaces: opts.workspaces,
    roles: opts.roles,
    workspaceRoles: opts.workspaceRoles,
    agents: opts.agents,
    sessions: opts.sessions,
    spawner: opts.spawner,
    hookUrl: opts.hookUrl,
  });
  registerWorkspaceRoutes(app, { workspaces: opts.workspaces });
  registerRoleRoutes(app, { roles: opts.roles });
  registerWorkspaceRoleRoutes(app, {
    workspaces: opts.workspaces,
    roles: opts.roles,
    workspaceRoles: opts.workspaceRoles,
  });

  return app;
}
