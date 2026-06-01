import type { FastifyInstance } from "fastify";
import type { SessionLocationsResponse } from "@clobber/shared";
import type { SessionStore } from "../session-store.ts";
import type { AgentStore } from "../agent-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { WorkspaceStore } from "../workspace-store.ts";
import { deskDirFor } from "../desk-store.ts";
import { officePathFor } from "../office-store.ts";

interface IdParam {
  id: string;
}

export function registerSessionLocationsRoutes(
  app: FastifyInstance,
  deps: {
    sessions: SessionStore;
    agents: AgentStore;
    roles: RoleStore;
    workspaces: WorkspaceStore;
  },
): void {
  // GET /sessions/:id/locations
  //
  // Returns the desk and office paths for the agent behind this session so
  // the composer footer can open a file browser rooted at either location.
  // office_path is null for ephemeral (non-persistent) roles.
  app.get<{ Params: IdParam }>("/sessions/:id/locations", async (request, reply) => {
    const session = deps.sessions.get(request.params.id);
    if (session === null) {
      reply.code(404);
      return { error: "session not found" };
    }
    if (session.agent_id === undefined) {
      reply.code(404);
      return { error: "session has no agent" };
    }
    const agent = deps.agents.get(session.agent_id);
    if (agent === null) {
      reply.code(404);
      return { error: "agent not found" };
    }
    const workspace = deps.workspaces.get(session.workspace_id);
    if (workspace === null) {
      reply.code(404);
      return { error: "workspace not found" };
    }
    const role = deps.roles.get(session.role_id);
    if (role === null) {
      reply.code(404);
      return { error: "role not found" };
    }
    const desk_path = deskDirFor(workspace.repo_path, agent.id);
    const office_path = role.persistent ? officePathFor(workspace.repo_path, agent.id) : null;
    const response: SessionLocationsResponse = { desk_path, office_path };
    return response;
  });
}
