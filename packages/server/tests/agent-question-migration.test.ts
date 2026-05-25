import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import type { AskQuestion } from "@clobber/shared";
import { migrateAgentQuestions } from "../src/agent-question-migration.ts";

/**
 * Builds a pre-#129 `agent_questions` table (per-field columns) so we can prove
 * the consolidation migration backfills `questions_json` and drops the legacy
 * shape — including the very old flat-string `options_json` form.
 */
function legacyDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agent_questions (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      question     TEXT NOT NULL,
      header       TEXT,
      options_json TEXT,
      multi_select INTEGER NOT NULL DEFAULT 0,
      status       TEXT NOT NULL,
      answer       TEXT,
      asked_at     INTEGER NOT NULL,
      answered_at  INTEGER
    );
  `);
  return db;
}

function readQuestions(db: Database, id: string): readonly AskQuestion[] {
  const row = db
    .prepare("SELECT questions_json FROM agent_questions WHERE id = ?")
    .get(id) as { questions_json: string };
  return JSON.parse(row.questions_json) as readonly AskQuestion[];
}

describe("migrateAgentQuestions", () => {
  it("consolidates legacy per-field rows into questions_json and drops old columns", () => {
    const db = legacyDb();
    db.prepare(
      "INSERT INTO agent_questions (id, session_id, question, header, options_json, multi_select, status, asked_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 1)",
    ).run(
      "rich",
      "s1",
      "merge?",
      "Merge",
      JSON.stringify([{ label: "yes" }, { label: "no", preview: "git revert" }]),
      1,
    );
    // Pre-rich-options row: flat string options, no header.
    db.prepare(
      "INSERT INTO agent_questions (id, session_id, question, header, options_json, multi_select, status, asked_at) VALUES (?, ?, ?, NULL, ?, 0, 'pending', 2)",
    ).run("flat", "s1", "go?", JSON.stringify(["ship", "hold"]));

    migrateAgentQuestions(db);

    expect(readQuestions(db, "rich")).toEqual([
      {
        question: "merge?",
        header: "Merge",
        multi_select: true,
        options: [{ label: "yes" }, { label: "no", preview: "git revert" }],
      },
    ]);
    expect(readQuestions(db, "flat")).toEqual([
      {
        question: "go?",
        multi_select: false,
        options: [{ label: "ship" }, { label: "hold" }],
      },
    ]);

    const cols = (
      db.prepare("PRAGMA table_info(agent_questions)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("questions_json");
    expect(cols).not.toContain("question");
    expect(cols).not.toContain("options_json");
    expect(cols).not.toContain("multi_select");
    expect(cols).not.toContain("header");
    db.close();
  });

  it("is a no-op on a DB already in the questions_json shape", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE agent_questions (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        questions_json TEXT NOT NULL, status TEXT NOT NULL,
        answer TEXT, asked_at INTEGER NOT NULL, answered_at INTEGER
      );
    `);
    expect(() => migrateAgentQuestions(db)).not.toThrow();
    db.close();
  });
});
