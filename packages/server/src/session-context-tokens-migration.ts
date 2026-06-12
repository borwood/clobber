import type { Database } from "bun:sqlite";

export function migrateSessionContextTokens(db: Database): void {
  const cols = (
    db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>
  ).map((r) => r.name);
  if (cols.includes("context_tokens")) return;
  db.exec("ALTER TABLE sessions ADD COLUMN context_tokens INTEGER");
}
