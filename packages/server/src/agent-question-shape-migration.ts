import type { Database } from "bun:sqlite";

export function migrateAgentQuestionShape(db: Database): void {
  ensureColumn(db, "agent_questions", "multi_select", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "agent_questions", "header", "TEXT");
  upgradeFlatOptionsToRich(db);
}

function ensureColumn(
  db: Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((r) => r.name);
  if (cols.includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function upgradeFlatOptionsToRich(db: Database): void {
  const rows = db
    .prepare(
      "SELECT id, options_json FROM agent_questions WHERE options_json IS NOT NULL",
    )
    .all() as Array<{ id: string; options_json: string }>;
  const update = db.prepare(
    "UPDATE agent_questions SET options_json = ? WHERE id = ?",
  );
  for (const row of rows) {
    const parsed = JSON.parse(row.options_json) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    if (typeof parsed[0] !== "string") continue;
    const rich = (parsed as string[]).map((label) => ({ label }));
    update.run(JSON.stringify(rich), row.id);
  }
}
