import type { Database } from "bun:sqlite";

export function migrateSessionRuntime(db: Database): void {
  ensureColumn(db, "sessions", "runtime_provider", "TEXT NOT NULL DEFAULT 'claude'");
  ensureColumn(db, "sessions", "provider_thread_id", "TEXT");
  db.exec(`
    UPDATE sessions
       SET runtime_provider = 'claude'
     WHERE runtime_provider IS NULL
        OR runtime_provider = ''
  `);
  db.exec(`
    UPDATE sessions
       SET provider_thread_id = id
     WHERE provider_thread_id IS NULL
       AND runtime_provider = 'claude'
  `);
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
