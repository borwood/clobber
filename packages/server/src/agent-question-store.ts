import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { AgentQuestionSchema, type AgentQuestion, type QuestionStatus } from "@clobber/shared";

export interface CreateAgentQuestionRequest {
  readonly session_id: string;
  readonly question: string;
  readonly options?: readonly string[];
}

export interface AgentQuestionStore {
  create(req: CreateAgentQuestionRequest): AgentQuestion;
  get(id: string): AgentQuestion | null;
  getOpenForSession(sessionId: string): AgentQuestion | null;
  answer(id: string, answer: string): boolean;
  timeout(id: string): boolean;
  cancelAllForSession(sessionId: string): string[];
}

interface Row {
  id: string;
  session_id: string;
  question: string;
  options_json: string | null;
  status: string;
  answer: string | null;
  asked_at: number;
  answered_at: number | null;
}

function rowToQuestion(row: Row): AgentQuestion {
  const input: Record<string, unknown> = {
    id: row.id,
    session_id: row.session_id,
    question: row.question,
    status: row.status as QuestionStatus,
    asked_at: row.asked_at,
  };
  if (row.options_json !== null) {
    input["options"] = JSON.parse(row.options_json) as readonly string[];
  }
  if (row.answer !== null) input["answer"] = row.answer;
  if (row.answered_at !== null) input["answered_at"] = row.answered_at;
  return AgentQuestionSchema.parse(input);
}

export function createAgentQuestionStore(db: Database): AgentQuestionStore {
  const insertStmt = db.prepare(`
    INSERT INTO agent_questions
      (id, session_id, question, options_json, status, answer, asked_at, answered_at)
    VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL)
  `);
  const getStmt = db.prepare("SELECT * FROM agent_questions WHERE id = ?");
  const getOpenForSessionStmt = db.prepare(`
    SELECT * FROM agent_questions
     WHERE session_id = ? AND status = 'pending'
     ORDER BY asked_at DESC, id DESC
     LIMIT 1
  `);
  const answerStmt = db.prepare(`
    UPDATE agent_questions
       SET status = 'answered', answer = ?, answered_at = ?
     WHERE id = ? AND status = 'pending'
  `);
  const timeoutStmt = db.prepare(`
    UPDATE agent_questions
       SET status = 'timed_out', answered_at = ?
     WHERE id = ? AND status = 'pending'
  `);
  const listPendingForSessionStmt = db.prepare(
    "SELECT id FROM agent_questions WHERE session_id = ? AND status = 'pending'",
  );
  const cancelAllForSessionStmt = db.prepare(`
    UPDATE agent_questions
       SET status = 'cancelled', answered_at = ?
     WHERE session_id = ? AND status = 'pending'
  `);

  return {
    create(req) {
      const id = randomUUID();
      const asked_at = Date.now();
      const optionsJson =
        req.options === undefined ? null : JSON.stringify(req.options);
      insertStmt.run(id, req.session_id, req.question, optionsJson, asked_at);
      return rowToQuestion({
        id,
        session_id: req.session_id,
        question: req.question,
        options_json: optionsJson,
        status: "pending",
        answer: null,
        asked_at,
        answered_at: null,
      });
    },

    get(id) {
      const row = getStmt.get(id) as Row | null;
      return row === null ? null : rowToQuestion(row);
    },

    getOpenForSession(sessionId) {
      const row = getOpenForSessionStmt.get(sessionId) as Row | null;
      return row === null ? null : rowToQuestion(row);
    },

    answer(id, answer) {
      const result = answerStmt.run(answer, Date.now(), id);
      return result.changes > 0;
    },

    timeout(id) {
      const result = timeoutStmt.run(Date.now(), id);
      return result.changes > 0;
    },

    cancelAllForSession(sessionId) {
      const rows = listPendingForSessionStmt.all(sessionId) as { id: string }[];
      const ids = rows.map((r) => r.id);
      cancelAllForSessionStmt.run(Date.now(), sessionId);
      return ids;
    },
  };
}
