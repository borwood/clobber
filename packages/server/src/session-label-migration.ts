import type { Database } from "bun:sqlite";

// `sessions.label` denormalizes the agent's display label so the sidebar
// can show it after the agent row is gone (non-persistent workers get
// deleted on session end). Backfills from `agents.label` for any session
// whose agent still exists; sessions whose agent was already deleted
// before this migration are unrecoverable and stay NULL.
export function migrateSessionLabel(db: Database): void {
  ensureColumn(db, "sessions", "label", "TEXT");
  db.exec(`
    UPDATE sessions
       SET label = (SELECT label FROM agents WHERE agents.id = sessions.agent_id)
     WHERE label IS NULL
       AND agent_id IS NOT NULL
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
