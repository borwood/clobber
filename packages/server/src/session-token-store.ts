import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

export interface SessionTokenLookup {
  readonly session_id: string;
  readonly created_at: number;
}

export interface SessionTokenStore {
  mint(sessionId: string): string;
  lookup(token: string): SessionTokenLookup | null;
  revoke(sessionId: string): void;
}

interface Row {
  token: string;
  session_id: string;
  created_at: number;
}

export function createSessionTokenStore(db: Database): SessionTokenStore {
  const insertStmt = db.prepare(
    "INSERT INTO session_tokens (token, session_id, created_at) VALUES (?, ?, ?)",
  );
  const deleteBySessionStmt = db.prepare(
    "DELETE FROM session_tokens WHERE session_id = ?",
  );
  const lookupStmt = db.prepare(
    "SELECT token, session_id, created_at FROM session_tokens WHERE token = ?",
  );

  return {
    mint(sessionId) {
      const token = randomBytes(32).toString("base64url");
      deleteBySessionStmt.run(sessionId);
      insertStmt.run(token, sessionId, Date.now());
      return token;
    },
    lookup(token) {
      const row = lookupStmt.get(token) as Row | null;
      if (row === null) return null;
      return { session_id: row.session_id, created_at: row.created_at };
    },
    revoke(sessionId) {
      deleteBySessionStmt.run(sessionId);
    },
  };
}
