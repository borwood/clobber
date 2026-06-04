import type { Database } from "bun:sqlite";

// `sessions.op_level_addon` persists the op-level system layer injected by the
// cycle operation (#502) so a resumed session re-composes the same orientation
// text. Absent on sessions started via plain spawn.
export function migrateSessionOpLevel(db: Database): void {
  const cols = (
    db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>
  ).map((r) => r.name);
  if (cols.includes("op_level_addon")) return;
  db.exec("ALTER TABLE sessions ADD COLUMN op_level_addon TEXT");
}
