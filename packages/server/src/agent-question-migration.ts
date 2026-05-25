import type { Database } from "bun:sqlite";
import { normalizeAskOptions, type AskQuestion } from "@clobber/shared";

/**
 * Consolidate the legacy per-field `agent_questions` shape
 * (`question/header/options_json/multi_select`) into the single
 * `questions_json` column that carries the full N-question ask. Fresh DBs are
 * created with `questions_json` already present and skip straight through.
 */
export function migrateAgentQuestions(db: Database): void {
  const cols = columnNames(db, "agent_questions");
  if (cols.includes("questions_json")) return;

  db.exec("ALTER TABLE agent_questions ADD COLUMN questions_json TEXT");
  backfill(db);
  for (const legacy of ["question", "header", "options_json", "multi_select"]) {
    if (cols.includes(legacy)) {
      db.exec(`ALTER TABLE agent_questions DROP COLUMN ${legacy}`);
    }
  }
}

interface LegacyRow {
  id: string;
  question: string;
  header: string | null;
  options_json: string | null;
  multi_select: number;
}

function backfill(db: Database): void {
  const rows = db
    .prepare(
      "SELECT id, question, header, options_json, multi_select FROM agent_questions",
    )
    .all() as LegacyRow[];
  const update = db.prepare(
    "UPDATE agent_questions SET questions_json = ? WHERE id = ?",
  );
  for (const row of rows) {
    const question: AskQuestion = {
      question: row.question,
      multi_select: row.multi_select === 1,
      ...(row.header === null ? {} : { header: row.header }),
      ...optionsField(row.options_json),
    };
    update.run(JSON.stringify([question]), row.id);
  }
}

function optionsField(
  optionsJson: string | null,
): { options?: AskQuestion["options"] } {
  if (optionsJson === null) return {};
  const parsed = JSON.parse(optionsJson) as readonly (string | { label: string })[];
  const options = normalizeAskOptions(parsed as never);
  return options === undefined ? {} : { options: [...options] };
}

function columnNames(db: Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((r) => r.name);
}
