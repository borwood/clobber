import type { Database } from "bun:sqlite";

// `session_tokens.scope_json` persists the baked CliScope at spawn time (#567).
// NULLABLE — existing tokens (NULL) fall back to live 2-tier resolution in
// authorizeCommand; only freshly-spawned tokens carry a baked scope.
export function migrateSessionTokenScope(db: Database): void {
  const cols = (
    db.prepare("PRAGMA table_info(session_tokens)").all() as Array<{ name: string }>
  ).map((r) => r.name);
  if (cols.includes("scope_json")) return;
  db.exec("ALTER TABLE session_tokens ADD COLUMN scope_json TEXT");
}
