import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  AgentQuestionSchema,
  type AgentQuestion,
  type AskQuestion,
  type QuestionStatus,
} from "@clobber/shared";

export interface CreateAgentQuestionRequest {
  readonly session_id: string;
  readonly questions: readonly AskQuestion[];
}

export interface ListAgentQuestionsFilter {
  readonly status?: QuestionStatus;
}

export interface AgentQuestionStore {
  create(req: CreateAgentQuestionRequest): AgentQuestion;
  get(id: string): AgentQuestion | null;
  getOpenForSession(sessionId: string): AgentQuestion | null;
  listForAgent(agentId: string, filter?: ListAgentQuestionsFilter): readonly AgentQuestion[];
  answer(id: string, answer: string): boolean;
  answerLate(id: string, answer: string): boolean;
  timeout(id: string): boolean;
  cancelAllForSession(sessionId: string): string[];
}

interface Row {
  id: string;
  session_id: string;
  questions_json: string;
  status: string;
  answer: string | null;
  asked_at: number;
  answered_at: number | null;
}

function rowToQuestion(row: Row): AgentQuestion {
  const input: Record<string, unknown> = {
    id: row.id,
    session_id: row.session_id,
    questions: JSON.parse(row.questions_json) as readonly AskQuestion[],
    status: row.status as QuestionStatus,
    asked_at: row.asked_at,
  };
  if (row.answer !== null) input["answer"] = row.answer;
  if (row.answered_at !== null) input["answered_at"] = row.answered_at;
  return AgentQuestionSchema.parse(input);
}

export function createAgentQuestionStore(db: Database): AgentQuestionStore {
  const insertStmt = db.prepare(`
    INSERT INTO agent_questions
      (id, session_id, questions_json, status, answer, asked_at, answered_at)
    VALUES (?, ?, ?, 'pending', NULL, ?, NULL)
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
  // The late-answer return path (#183): a timed-out ask is answered after the
  // fact, so it moves timed_out → answered (the pending → answered guard would
  // never match here).
  const answerLateStmt = db.prepare(`
    UPDATE agent_questions
       SET status = 'answered', answer = ?, answered_at = ?
     WHERE id = ? AND status = 'timed_out'
  `);
  const timeoutStmt = db.prepare(`
    UPDATE agent_questions
       SET status = 'timed_out', answered_at = ?
     WHERE id = ? AND status = 'pending'
  `);
  const listPendingForSessionStmt = db.prepare(
    "SELECT id FROM agent_questions WHERE session_id = ? AND status = 'pending'",
  );
  const listForAgentStmt = db.prepare(`
    SELECT aq.* FROM agent_questions aq
    JOIN sessions s ON aq.session_id = s.id
    WHERE s.agent_id = ?
    ORDER BY aq.asked_at DESC, aq.id DESC
  `);
  const listForAgentWithStatusStmt = db.prepare(`
    SELECT aq.* FROM agent_questions aq
    JOIN sessions s ON aq.session_id = s.id
    WHERE s.agent_id = ? AND aq.status = ?
    ORDER BY aq.asked_at DESC, aq.id DESC
  `);
  const cancelAllForSessionStmt = db.prepare(`
    UPDATE agent_questions
       SET status = 'cancelled', answered_at = ?
     WHERE session_id = ? AND status = 'pending'
  `);

  return {
    create(req) {
      const id = randomUUID();
      const asked_at = Date.now();
      const questionsJson = JSON.stringify(req.questions);
      insertStmt.run(id, req.session_id, questionsJson, asked_at);
      return rowToQuestion({
        id,
        session_id: req.session_id,
        questions_json: questionsJson,
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

    listForAgent(agentId, filter) {
      if (filter?.status !== undefined) {
        const rows = listForAgentWithStatusStmt.all(agentId, filter.status) as Row[];
        return rows.map(rowToQuestion);
      }
      const rows = listForAgentStmt.all(agentId) as Row[];
      return rows.map(rowToQuestion);
    },

    answer(id, answer) {
      const result = answerStmt.run(answer, Date.now(), id);
      return result.changes > 0;
    },

    answerLate(id, answer) {
      const result = answerLateStmt.run(answer, Date.now(), id);
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
