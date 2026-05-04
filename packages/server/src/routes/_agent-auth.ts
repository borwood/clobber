import type { FastifyRequest } from "fastify";
import type { Session } from "@clobber/shared";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { SessionStore } from "../session-store.ts";

const BEARER = "Bearer ";

export interface AgentAuthDeps {
  readonly sessionTokens: SessionTokenStore;
  readonly sessions: SessionStore;
}

export type AuthResult =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly status: 401; readonly error: string };

export function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  if (!header.startsWith(BEARER)) return null;
  const token = header.slice(BEARER.length).trim();
  return token.length === 0 ? null : token;
}

export function resolveCallerSession(
  req: FastifyRequest,
  deps: AgentAuthDeps,
): AuthResult {
  const token = extractBearer(req);
  if (token === null) {
    return { ok: false, status: 401, error: "missing or malformed authorization header" };
  }
  const lookup = deps.sessionTokens.lookup(token);
  if (lookup === null) {
    return { ok: false, status: 401, error: "invalid or revoked token" };
  }
  const session = deps.sessions.get(lookup.session_id);
  if (session === null || session.ended_at !== undefined) {
    return { ok: false, status: 401, error: "session no longer active" };
  }
  return { ok: true, session };
}
