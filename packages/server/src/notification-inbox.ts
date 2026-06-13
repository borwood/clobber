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
  // Quiet rows are drained via the hook drain producer — excluding them here
  // prevents double-delivery at session start (fork iii ruling).
  const rows = store.listUnackedForAgent(agentId).filter((n) => n.delivery_mode !== "quiet");
  if (rows.length === 0) return NEAR_SILENT;
  const RENDER_CAP = 8;
  const visible = rows.slice(0, RENDER_CAP);
  const olderCount = rows.length - visible.length;
  const lines: string[] = [
    `[Unacknowledged notifications — ${rows.length} pending. Use \`clobber notify list\` / \`clobber notify ack <id>\` to review and clear.]`,
    "",
  ];
  for (const n of visible) {
    const ts = new Date(n.created_at).toISOString();
    lines.push(`  [${ts}] (${n.type} / ${n.priority}) ${n.payload.body}`);
  }
  if (olderCount > 0) {
    lines.push(`  (${olderCount} older — run \`clobber notify list\` to see all)`);
  }
  lines.push("", "[End of notifications]", "");
  return lines.join("\n");
}
