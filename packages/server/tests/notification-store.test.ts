import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateNotification } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";

function seedAgent(db: ReturnType<typeof createDatabase>): {
  workspaceId: string;
  agentId: string;
} {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-notif-store-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const workspaces = createWorkspaceStore(db);
  const agents = createAgentStore(db);
  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);
  const roleRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string };
  const agent = agents.create({ workspace_id: ws.id, role_id: roleRow.id });
  return { workspaceId: ws.id, agentId: agent.id };
}

function makeReq(agentId: string): CreateNotification {
  return {
    type: "trigger",
    recipient: { kind: "agent", agent_id: agentId },
    priority: "low",
    payload: { body: "a cron fired: 0 9 * * *", tag: { kind: "trigger", attrs: { via: "cron" } } },
    provenance: { source_kind: "trigger", emitter_agent_id: agentId },
    metadata: { wake_program: "orient" },
  };
}

describe("notification-store", () => {
  it("creates a pending notification and reads it back faithfully", () => {
    const db = createDatabase(":memory:");
    const { agentId } = seedAgent(db);
    const store = createNotificationStore(db);

    const n = store.create(makeReq(agentId), 1_700_000_000_000);
    expect(n.state).toBe("pending");
    expect(n.created_at).toBe(1_700_000_000_000);
    expect(n.delivered_at).toBeUndefined();
    expect(n.recipient).toEqual({ kind: "agent", agent_id: agentId });
    expect(n.priority).toBe("low");
    expect(n.payload).toEqual({
      body: "a cron fired: 0 9 * * *",
      tag: { kind: "trigger", attrs: { via: "cron" } },
    });
    expect(n.provenance.source_kind).toBe("trigger");
    expect(n.metadata).toEqual({ wake_program: "orient" });

    const readBack = store.get(n.id);
    expect(readBack).toEqual(n);
    db.close();
  });

  it("markDelivered advances pending → delivered and stamps delivered_at", () => {
    const db = createDatabase(":memory:");
    const { agentId } = seedAgent(db);
    const store = createNotificationStore(db);

    const n = store.create(makeReq(agentId), 1_700_000_000_000);
    store.markDelivered(n.id, 1_700_000_000_500);

    const after = store.get(n.id);
    expect(after!.state).toBe("delivered");
    expect(after!.delivered_at).toBe(1_700_000_000_500);
    db.close();
  });

  it("listForAgent returns a recipient's notifications newest-first", () => {
    const db = createDatabase(":memory:");
    const { agentId } = seedAgent(db);
    const store = createNotificationStore(db);

    store.create(makeReq(agentId), 1_700_000_000_000);
    store.create(makeReq(agentId), 1_700_000_001_000);
    const rows = store.listForAgent(agentId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.created_at).toBe(1_700_000_001_000);
    expect(rows[1]!.created_at).toBe(1_700_000_000_000);
    db.close();
  });

  it("supports a user recipient with no agent_id", () => {
    const db = createDatabase(":memory:");
    seedAgent(db);
    const store = createNotificationStore(db);
    const n = store.create(
      {
        type: "message",
        recipient: { kind: "user" },
        priority: "high",
        payload: { body: "hi", tag: { kind: "message" } },
        provenance: { source_kind: "message" },
      },
      1,
    );
    expect(store.get(n.id)!.recipient).toEqual({ kind: "user" });
    db.close();
  });
});

describe("notifications migration", () => {
  it("creates the notifications table on a fresh DB", () => {
    const db = createDatabase(":memory:");
    const { agentId } = seedAgent(db);
    const store = createNotificationStore(db);
    const n = store.create(makeReq(agentId), 1);
    expect(store.get(n.id)!.state).toBe("pending");
    db.close();
  });

  it("adds notifications to a populated pre-existing DB without disturbing prior data", () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-notif-migration-"));
    const path = join(dir, "clobber.db");
    try {
      // Stand up a populated DB, then DROP the notifications table to simulate a
      // pre-#425 database that predates the spine.
      const db1 = createDatabase(path);
      const { agentId } = seedAgent(db1);
      const wsBefore = db1.prepare("SELECT COUNT(*) AS c FROM workspaces").get() as { c: number };
      expect(wsBefore.c).toBe(1);
      db1.exec("DROP TABLE notifications");
      expect(
        db1
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notifications'")
          .get(),
      ).toBeNull();
      db1.close();

      // Re-open through the migration path — the table is recreated and the prior
      // rows survive untouched.
      const db2 = createDatabase(path);
      const wsAfter = db2.prepare("SELECT COUNT(*) AS c FROM workspaces").get() as { c: number };
      expect(wsAfter.c).toBe(1);
      const agentAfter = db2.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number };
      expect(agentAfter.c).toBe(1);

      const store = createNotificationStore(db2);
      const n = store.create(makeReq(agentId), 42);
      expect(store.get(n.id)!.state).toBe("pending");
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
