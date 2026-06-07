import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

export interface SessionTokenLookup {
  readonly session_id: string;
  readonly created_at: number;
  readonly scope_json: string | null;
}

export interface SessionTokenStore {
  mint(sessionId: string, scopeJson?: string | null): string;
  register(sessionId: string, token: string, scopeJson?: string | null): void;
  lookup(token: string): SessionTokenLookup | null;
  // Returns the baked scope for a session's current token row, without needing
  // the token value. Used by the agents listing to surface effective_scope.
  scopeForSession(sessionId: string): string | null;
  revoke(sessionId: string): void;
}

export function generateTokenValue(): string {
  return randomBytes(32).toString("base64url");
}

interface Row {
  token: string;
  session_id: string;
  created_at: number;
  scope_json: string | null;
}

export function createSessionTokenStore(db: Database): SessionTokenStore {
  const insertStmt = db.prepare(
    "INSERT INTO session_tokens (token, session_id, created_at, scope_json) VALUES (?, ?, ?, ?)",
  );
  const deleteBySessionStmt = db.prepare(
    "DELETE FROM session_tokens WHERE session_id = ?",
  );
  const lookupStmt = db.prepare(
    "SELECT token, session_id, created_at, scope_json FROM session_tokens WHERE token = ?",
  );
  const scopeBySessionStmt = db.prepare(
    "SELECT scope_json FROM session_tokens WHERE session_id = ?",
  );

  function registerImpl(sessionId: string, token: string, scopeJson?: string | null): void {
    deleteBySessionStmt.run(sessionId);
    insertStmt.run(token, sessionId, Date.now(), scopeJson ?? null);
  }

  return {
    mint(sessionId, scopeJson) {
      const token = generateTokenValue();
      registerImpl(sessionId, token, scopeJson);
      return token;
    },
    register(sessionId, token, scopeJson) {
      registerImpl(sessionId, token, scopeJson);
    },
    lookup(token) {
      const row = lookupStmt.get(token) as Row | null;
      if (row === null) return null;
      return { session_id: row.session_id, created_at: row.created_at, scope_json: row.scope_json };
    },
    scopeForSession(sessionId) {
      const row = scopeBySessionStmt.get(sessionId) as { scope_json: string | null } | null;
      if (row === null) return null;
      return row.scope_json;
    },
    revoke(sessionId) {
      deleteBySessionStmt.run(sessionId);
    },
  };
}
