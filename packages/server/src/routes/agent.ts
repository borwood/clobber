import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";

export interface AgentRouteDeps {
  readonly sessionTokens: SessionTokenStore;
  readonly sessions: SessionStore;
  readonly roles: RoleStore;
}

const BEARER = "Bearer ";

function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  if (!header.startsWith(BEARER)) return null;
  const token = header.slice(BEARER.length).trim();
  return token.length === 0 ? null : token;
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  app.get("/agent/me", async (request, reply) => {
    const token = extractBearer(request);
    if (token === null) {
      reply.code(401);
      return { error: "missing or malformed authorization header" };
    }
    const lookup = deps.sessionTokens.lookup(token);
    if (lookup === null) {
      reply.code(401);
      return { error: "invalid or revoked token" };
    }
    const session = deps.sessions.get(lookup.session_id);
    if (session === null || session.ended_at !== undefined) {
      reply.code(401);
      return { error: "session no longer active" };
    }
    const role = deps.roles.get(session.role_id);
    if (role === null) {
      reply.code(500);
      return { error: "role missing for session" };
    }
    return {
      session_id: session.id,
      workspace_id: session.workspace_id,
      role: { id: role.id, name: role.name },
      started_at: session.started_at,
    };
  });
}
