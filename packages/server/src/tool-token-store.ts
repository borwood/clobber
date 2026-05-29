import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";

/**
 * Durable store for tool-token bindings (#321). A token binds a one-time,
 * unguessable secret to `(target_session_id, tool, saved-args)`. It lives in
 * the audit DB alongside `session_tokens` so a server restart mid-decision
 * never silently drops a live token, and it carries **no expiry** — a
 * deliberate decision has no deadline (#241). The uniqueness on
 * `(target_session_id, tool)` is what makes re-issuing revoke-and-replace:
 * minting again for the same target+tool drops the prior row, so the stale
 * token is dead the moment fresh args are bound.
 */
export interface ToolTokenBinding {
  readonly token: string;
  readonly target_session_id: string;
  readonly tool: string;
  readonly args_json: string;
  readonly created_at: number;
}

export interface ToolTokenStore {
  // Revoke any prior token for (target, tool), then mint a fresh one bound to
  // the saved args. Returns the new token value.
  mint(input: { targetSessionId: string; tool: string; argsJson: string }): string;
  lookup(token: string): ToolTokenBinding | null;
  // One-time consumption, called only after a successful action.
  consume(token: string): void;
  revoke(input: { targetSessionId: string; tool: string }): void;
}

function generateToolTokenValue(): string {
  return randomBytes(32).toString("base64url");
}

interface Row {
  token: string;
  target_session_id: string;
  tool: string;
  args_json: string;
  created_at: number;
}

export function createToolTokenStore(db: Database): ToolTokenStore {
  const deleteByTargetToolStmt = db.prepare(
    "DELETE FROM tool_tokens WHERE target_session_id = ? AND tool = ?",
  );
  const insertStmt = db.prepare(
    "INSERT INTO tool_tokens (token, target_session_id, tool, args_json, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const lookupStmt = db.prepare("SELECT * FROM tool_tokens WHERE token = ?");
  const deleteByTokenStmt = db.prepare("DELETE FROM tool_tokens WHERE token = ?");

  return {
    mint({ targetSessionId, tool, argsJson }) {
      const token = generateToolTokenValue();
      deleteByTargetToolStmt.run(targetSessionId, tool);
      insertStmt.run(token, targetSessionId, tool, argsJson, Date.now());
      return token;
    },
    lookup(token) {
      const row = lookupStmt.get(token) as Row | null;
      if (row === null) return null;
      return {
        token: row.token,
        target_session_id: row.target_session_id,
        tool: row.tool,
        args_json: row.args_json,
        created_at: row.created_at,
      };
    },
    consume(token) {
      deleteByTokenStmt.run(token);
    },
    revoke({ targetSessionId, tool }) {
      deleteByTargetToolStmt.run(targetSessionId, tool);
    },
  };
}
