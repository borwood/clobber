import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";

// RFC 4648 base32, lowercased. 256 is a clean multiple of 32, so `byte % 32`
// draws uniformly — no modulo bias. Ten chars give 50 bits, well inside the
// 8–12 char window the spec asks for and far past any collision concern.
const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const TOKEN_LENGTH = 10;

function generateToken(): string {
  const bytes = randomBytes(TOKEN_LENGTH);
  let token = "";
  for (const byte of bytes) token += TOKEN_ALPHABET[byte % 32];
  return token;
}

export interface AgentMessageToken {
  readonly token: string;
  readonly originator_session_id: string;
  readonly recipient_session_id: string;
  readonly originator_agent_id: string | null;
  readonly recipient_agent_id: string | null;
  readonly message_id: string;
  readonly created_at: number;
  readonly redeemed_at: number | null;
}

export interface IssueTokenRequest {
  readonly originator_session_id: string;
  readonly recipient_session_id: string;
  readonly originator_agent_id: string;
  readonly recipient_agent_id: string;
}

export interface AgentMessageStore {
  // Mint a reply capability bound to (originator, recipient, message_id). The
  // message_id is generated here and returned so the caller can record it.
  issue(req: IssueTokenRequest): AgentMessageToken;
  get(token: string): AgentMessageToken | null;
  // Stamp `redeemed_at` iff not yet redeemed. Returns true when this call
  // consumed the token, false when it was already spent (the double-redeem).
  redeem(token: string): boolean;
}

interface Row {
  token: string;
  originator_session_id: string;
  recipient_session_id: string;
  originator_agent_id: string | null;
  recipient_agent_id: string | null;
  message_id: string;
  created_at: number;
  redeemed_at: number | null;
}

function rowToToken(row: Row): AgentMessageToken {
  return {
    token: row.token,
    originator_session_id: row.originator_session_id,
    recipient_session_id: row.recipient_session_id,
    originator_agent_id: row.originator_agent_id,
    recipient_agent_id: row.recipient_agent_id,
    message_id: row.message_id,
    created_at: row.created_at,
    redeemed_at: row.redeemed_at,
  };
}

export function createAgentMessageStore(db: Database): AgentMessageStore {
  const insertStmt = db.prepare(`
    INSERT INTO agent_message_tokens
      (token, originator_session_id, recipient_session_id, originator_agent_id, recipient_agent_id,
       message_id, created_at, redeemed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    RETURNING *
  `);
  const getStmt = db.prepare("SELECT * FROM agent_message_tokens WHERE token = ?");
  const redeemStmt = db.prepare(
    "UPDATE agent_message_tokens SET redeemed_at = ? WHERE token = ? AND redeemed_at IS NULL",
  );

  return {
    issue(req) {
      const row = insertStmt.get(
        generateToken(),
        req.originator_session_id,
        req.recipient_session_id,
        req.originator_agent_id,
        req.recipient_agent_id,
        randomUUID(),
        Date.now(),
      ) as Row;
      return rowToToken(row);
    },

    get(token) {
      const row = getStmt.get(token) as Row | null;
      return row === null ? null : rowToToken(row);
    },

    redeem(token) {
      return redeemStmt.run(Date.now(), token).changes > 0;
    },
  };
}
