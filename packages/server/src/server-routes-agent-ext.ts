import type { FastifyInstance } from "fastify";
import { registerAgentRolesRoutes } from "./routes/agent-roles.ts";
import { registerAgentRolesDriftSweepRoute } from "./routes/agent-roles-drift-sweep.ts";
import { registerAgentSelfSkillsRoutes } from "./routes/agent-self-skills.ts";
import { registerAgentAskRoutes } from "./routes/agent-ask.ts";
import { registerAgentRolesPromptModulesRoutes } from "./routes/agent-roles-prompt-modules.ts";
import { registerAgentRolesWakeProgramsRoutes } from "./routes/agent-roles-wake-programs.ts";
import { registerAgentPromptModulesRoutes } from "./routes/agent-prompt-modules.ts";
import { registerSessionResumeRoutes } from "./routes/session-resume.ts";
import {
  registerNotificationsRoutes,
  registerAgentNotificationsRoutes,
} from "./routes/agent-notifications.ts";
import { registerAgentWorktreesRoutes } from "./routes/agent-worktrees.ts";
import type { ServerOptions } from "./types.ts";
import type { ServerDeps } from "./server-deps.ts";

export function registerAgentExtRoutes(
  app: FastifyInstance,
  opts: ServerOptions,
  deps: ServerDeps,
): void {
  const { roleEmbodiment, agentMessages, notificationDispatcher, scheduler, spawnPipelineDeps, resumeEnded, rearmDeps } = deps;

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
  registerAgentRolesDriftSweepRoute(app, {
    roles: opts.roles,
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
    workspaces: opts.workspaces,
    agentQuestions: opts.agentQuestions,
    agentQuestionWaiter: opts.agentQuestionWaiter,
    ...(opts.askPollWindowMs === undefined ? {} : { askPollWindowMs: opts.askPollWindowMs }),
    ...roleEmbodiment,
  });
  registerAgentRolesPromptModulesRoutes(app, {
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
  registerAgentRolesWakeProgramsRoutes(app, {
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
  registerAgentPromptModulesRoutes(app, {
    sessionTokens: opts.sessionTokens,
    sessions: opts.sessions,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    workspaces: opts.workspaces,
    ...roleEmbodiment,
  });
  registerSessionResumeRoutes(app, {
    sessions: opts.sessions,
    agents: opts.agents,
    roles: opts.roles,
    workspaces: opts.workspaces,
    spawnPipelineDeps,
    resumeEnded,
    rearmDeps,
    agentMessages,
  });
  registerAgentWorktreesRoutes(app, {
    sessionTokens: opts.sessionTokens,
    sessions: opts.sessions,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    workspaces: opts.workspaces,
    agents: opts.agents,
    ...roleEmbodiment,
  });
  registerNotificationsRoutes(app, {
    notifications: deps.notificationStore,
    clock: deps.clock,
  });
  registerAgentNotificationsRoutes(app, {
    notifications: deps.notificationStore,
    clock: deps.clock,
    sessionTokens: opts.sessionTokens,
    sessions: opts.sessions,
    roles: opts.roles,
    roleVersions: opts.roleVersions,
    workspaces: opts.workspaces,
    ...(opts.roleContentCache !== undefined ? { roleContentCache: opts.roleContentCache } : {}),
    ...(opts.roleRepoDir !== undefined ? { roleRepoDir: opts.roleRepoDir } : {}),
  });
}
