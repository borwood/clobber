import type { Database } from "bun:sqlite";

// Add nullable spawner_agent_id to agents so the confirm-resume path (#621)
// can resolve the capability-holder (owner) of an ephemeral agent.
// Additive: existing rows get NULL (no owner recorded) — current behaviour preserved.
export function migrateAgentSpawner(db: Database): void {
  const cols = (
    db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>
  ).map((r) => r.name);
  if (!cols.includes("spawner_agent_id")) {
    db.exec("ALTER TABLE agents ADD COLUMN spawner_agent_id TEXT");
  }
}
