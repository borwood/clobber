import type { Database } from "bun:sqlite";

export function migrateAgentMessageTokenAgentIds(db: Database): void {
  const cols = (
    db.prepare("PRAGMA table_info(agent_message_tokens)").all() as Array<{ name: string }>
  ).map((r) => r.name);
  if (!cols.includes("originator_agent_id")) {
    db.exec("ALTER TABLE agent_message_tokens ADD COLUMN originator_agent_id TEXT");
  }
  if (!cols.includes("recipient_agent_id")) {
    db.exec("ALTER TABLE agent_message_tokens ADD COLUMN recipient_agent_id TEXT");
  }
}
