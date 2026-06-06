import type { NotificationStore } from "./notification-store.ts";

// Dilution guard: zero un-acked → return near-silent one-liner so the boot
// surface stays high-charge. Expands only when there are rows to surface.
const NEAR_SILENT = "[Notifications: none pending]\n";

// Non-flushing boot re-dump — reads un-acked notifications for the agent and
// renders them as a seed block. READS ONLY — does not mutate state. Distinct
// from the consuming agent-work-queue drain which clears in-memory state.
export function composeUnackedNotifications(
  agentId: string,
  store: NotificationStore,
): string {
  const rows = store.listUnackedForAgent(agentId);
  if (rows.length === 0) return NEAR_SILENT;
  const lines: string[] = [
    `[Unacknowledged notifications — ${rows.length} pending]`,
    "",
  ];
  for (const n of rows) {
    const ts = new Date(n.created_at).toISOString();
    lines.push(`  [${ts}] (${n.type} / ${n.priority}) ${n.payload.body}`);
  }
  lines.push("", "[End of notifications]", "");
  return lines.join("\n");
}
