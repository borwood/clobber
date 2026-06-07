import type { FastifyRequest } from "fastify";
import { isCliCommandAllowed, isActionAllowed, type CliScope, type Session } from "@clobber/shared";
import type { SessionTokenStore } from "../session-token-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { RoleStore } from "../role-store.ts";
import type { RoleVersionStore } from "../role-version-store.ts";
import type { RoleContentCache } from "../role-content-cache.ts";
import type { WorkspaceStore } from "../workspace-store.ts";
import { resolveCurrentRoleVersion } from "../resolve-role-content.ts";

const BEARER = "Bearer ";

export interface AgentAuthDeps {
  readonly sessionTokens: SessionTokenStore;
  readonly sessions: SessionStore;
}

export interface CommandAuthzDeps {
  readonly roles: RoleStore;
  readonly roleVersions: RoleVersionStore;
  // #361 — present when git-as-truth is configured, so the gate resolves a
  // commit-pinned role's allow-list from the materialized tree, not a row.
  readonly roleContentCache?: RoleContentCache;
  readonly roleRepoDir?: string;
  // #565 — workspace perms tier: loaded here to intersect with the role tier.
  readonly workspaces: Pick<WorkspaceStore, "get">;
}

export type AuthResult =
  | { readonly ok: true; readonly session: Session; readonly scope_json: string | null }
  | { readonly ok: false; readonly status: 401; readonly error: string };

export type AuthzResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 403 | 500; readonly error: string };

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
  return { ok: true, session, scope_json: lookup.scope_json };
}

export function authorizeCommand(
  session: Session,
  commandName: string,
  deps: CommandAuthzDeps,
  scopeJson?: string | null,
): AuthzResult {
  // Baked scope present — use it directly as a single-tier check.
  if (scopeJson !== null && scopeJson !== undefined) {
    const baked = JSON.parse(scopeJson) as CliScope;
    if (!isActionAllowed(baked, commandName)) {
      return {
        ok: false,
        status: 403,
        error: `command '${commandName}' denied by workspace permissions`,
      };
    }
    return { ok: true };
  }

  // NULL scope → fall-back to live 2-tier resolution (migration-safety invariant:
  // tokens that pre-date scope_json baking resolve identically to the live path).
  const role = deps.roles.get(session.role_id);
  if (role === null) {
    return { ok: false, status: 500, error: "role missing for session" };
  }
  const version = resolveCurrentRoleVersion(role, deps);
  if (version === null) {
    return {
      ok: false,
      status: 500,
      error: `role '${role.name}' has no current version`,
    };
  }
  const allowed = JSON.parse(version.allowed_cli_commands_json) as readonly string[];
  if (!isCliCommandAllowed(allowed, commandName)) {
    return {
      ok: false,
      status: 403,
      error: `command '${commandName}' not allowed for role '${role.name}'`,
    };
  }
  const workspace = deps.workspaces.get(session.workspace_id);
  if (workspace === null) {
    return { ok: false, status: 500, error: "workspace missing for session" };
  }
  if (!isActionAllowed(workspace.perms_scope, commandName)) {
    return {
      ok: false,
      status: 403,
      error: `command '${commandName}' denied by workspace permissions`,
    };
  }
  return { ok: true };
}
