/**
 * #652 — render-cap for composeUnackedNotifications boot re-dump.
 * Newest 8 shown; a pointer line appears when there are older rows.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateNotification } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import { composeUnackedNotifications } from "../src/notification-inbox.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";

function makeHarness() {
  const db = createDatabase(":memory:");
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-inbox-cap-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const workspaces = createWorkspaceStore(db);
  const agents = createAgentStore(db);
  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);
  const roleRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string };
  const agent = agents.create({ workspace_id: ws.id, role_id: roleRow.id });
  const store = createNotificationStore(db);
  return { db, store, agentId: agent.id };
}

function agentNotif(agentId: string, body: string): CreateNotification {
  return {
    type: "trigger",
    category: "transient",
    recipient: { kind: "agent", agent_id: agentId },
    priority: "high",
    payload: { body, tag: { kind: "trigger", attrs: { via: "cron" } } },
    provenance: { source_kind: "trigger" },
  };
}

const CAP = 8;

describe("composeUnackedNotifications — render cap (#652)", () => {
  it("zero unacked: returns near-silent, no cap pointer added", () => {
    const h = makeHarness();
    const out = composeUnackedNotifications(h.agentId, h.store);
    expect(out.length).toBeLessThan(100);
    expect(out).not.toContain("older");
    h.db.close();
  });

  it(`exactly ${CAP} unacked: all rows shown, no older-count pointer line`, () => {
    const h = makeHarness();
    for (let i = 0; i < CAP; i++) {
      h.store.create(agentNotif(h.agentId, `msg-${i}`), 1_700_000_000_000 + i * 1000);
    }
    const out = composeUnackedNotifications(h.agentId, h.store);
    for (let i = 0; i < CAP; i++) {
      expect(out).toContain(`msg-${i}`);
    }
    expect(out).not.toContain("older");
    h.db.close();
  });

  it(`${CAP + 3} unacked: only ${CAP} newest bodies shown, rest elided with pointer`, () => {
    const h = makeHarness();
    const total = CAP + 3;
    // Store returns newest-first (created_at DESC), so higher index = newer = shown.
    // Use zero-padded names so "old-00" can't appear as a substring of "new-10" etc.
    for (let i = 0; i < total; i++) {
      const label = i < 3 ? `old-${String(i).padStart(2, "0")}` : `new-${String(i).padStart(2, "0")}`;
      h.store.create(agentNotif(h.agentId, label), 1_700_000_000_000 + i * 1000);
    }
    const out = composeUnackedNotifications(h.agentId, h.store);
    // The newest CAP bodies (the "new-*" labels) must appear
    for (let i = 3; i < total; i++) {
      expect(out).toContain(`new-${String(i).padStart(2, "0")}`);
    }
    // The 3 oldest bodies must NOT appear
    for (let i = 0; i < 3; i++) {
      expect(out).not.toContain(`old-${String(i).padStart(2, "0")}`);
    }
    // Pointer line must be present
    expect(out).toContain("older");
    expect(out).toContain("clobber notify list");
    h.db.close();
  });

  it("pointer line states the elided count correctly", () => {
    const h = makeHarness();
    const total = 15;
    for (let i = 0; i < total; i++) {
      h.store.create(agentNotif(h.agentId, `n-${i}`), 1_700_000_000_000 + i * 1000);
    }
    const out = composeUnackedNotifications(h.agentId, h.store);
    const elided = total - CAP;
    expect(out).toContain(`${elided} older`);
    h.db.close();
  });

  it("compose still does NOT mutate notification state when >8 rows", () => {
    const h = makeHarness();
    for (let i = 0; i < CAP + 2; i++) {
      h.store.create(agentNotif(h.agentId, `n-${i}`), 1_700_000_000_000 + i * 1000);
    }
    composeUnackedNotifications(h.agentId, h.store);
    const rows = h.store.listUnackedForAgent(h.agentId);
    expect(rows).toHaveLength(CAP + 2);
    for (const r of rows) {
      expect(r.state).toBe("pending");
    }
    h.db.close();
  });
});
