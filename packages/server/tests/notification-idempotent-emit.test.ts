import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateNotification, Notification, RoleTrigger } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createAgentRegistry } from "../src/agent-registry.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import {
  createNotificationDispatcher,
  type DeliveryOutcome,
} from "../src/notification-dispatch.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { createTestClock } from "../src/clock.ts";
import { defaultSynthesizePrompt } from "../src/trigger-synthesize.ts";
import {
  dispatchTrigger,
  type AgentBinding,
  type DispatchDeps,
} from "../src/trigger-dispatch.ts";
import { claudeRuntimeProvider } from "@clobber/runtime";
import type { AttachSessionFn, AttachOutcome } from "../src/trigger-attach.ts";
import type { CompletionWakePayload } from "../src/completion-wake.ts";

// ─── shared fixtures ──────────────────────────────────────────────────────────

function seedWorkspace(db: ReturnType<typeof createDatabase>): {
  workspaceId: string;
  agentId: string;
  roleId: string;
} {
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-idempotent-emit-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const workspaces = createWorkspaceStore(db);
  const agents = createAgentStore(db);
  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);
  const roleRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string };
  const agent = agents.create({ workspace_id: ws.id, role_id: roleRow.id, label: "mgr" });
  return { workspaceId: ws.id, agentId: agent.id, roleId: roleRow.id };
}

const NOOP_TRANSPORT = async (_n: Notification): Promise<DeliveryOutcome> => ({
  action: "queued",
});

// ─── AC1 ─────────────────────────────────────────────────────────────────────
// Same logical event emitted twice: the store must produce exactly 1 row AND
// the transport must be invoked exactly once. Counting rows alone is the
// green-but-inert trap (#430/#522) — we count DELIVERY calls here.
describe("AC1 — non-inert dedup: same logical event twice → 1 row, transport once", () => {
  it("emitting the same source_id twice: 1 row, transport called exactly once, 2nd returns skipped-duplicate", async () => {
    const db = createDatabase(":memory:");
    const { agentId } = seedWorkspace(db);
    const store = createNotificationStore(db);
    const clock = createTestClock(new Date("2026-06-01T09:00:00Z"));
    const dispatcher = createNotificationDispatcher(store, clock);

    const req: CreateNotification = {
      type: "trigger",
      recipient: { kind: "agent", agent_id: agentId },
      priority: "low",
      payload: { body: "wake", tag: { kind: "trigger", attrs: { via: "worker-done" } } },
      provenance: { source_kind: "trigger", source_id: "session-abc-123" },
    };

    let transportCount = 0;
    const countingTransport = async (n: Notification): Promise<DeliveryOutcome> => {
      transportCount++;
      return NOOP_TRANSPORT(n);
    };

    const r1 = await dispatcher.emit(req, countingTransport);
    const r2 = await dispatcher.emit(req, countingTransport);

    // Exactly 1 row — duplicates must not accumulate
    expect(store.listForAgent(agentId)).toHaveLength(1);

    // Transport invoked exactly once — the storm is gated, not just row-deduplicated
    expect(transportCount).toBe(1);

    // 1st emit went through transport normally
    expect(r1.outcome.action).not.toBe("skipped-duplicate");

    // 2nd emit short-circuited at the idempotency gate
    expect(r2.outcome.action).toBe("skipped-duplicate");

    // Both returns carry the same underlying notification row
    expect(r2.notification.id).toBe(r1.notification.id);

    db.close();
  });
});

// ─── AC2 ─────────────────────────────────────────────────────────────────────
// Two completion triggers for different sessions must NOT be collapsed.
// This guards the source_id re-grain in trigger-dispatch: if source_id stays
// "trigger.kind" (= "worker-done" for both) they share the same logical key
// and the 2nd event is swallowed.
interface DispatchHarness {
  deps: DispatchDeps;
  binding: AgentBinding;
  notifications: ReturnType<typeof createNotificationStore>;
}

function makeDispatchHarness(): DispatchHarness {
  const db = createDatabase(":memory:");
  const clock = createTestClock(new Date("2026-06-01T09:00:00Z"));
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const registry = createAgentRegistry();
  const dispatches = createTriggerDispatchStore(db);
  const notifications = createNotificationStore(db);
  const dispatcher = createNotificationDispatcher(notifications, clock);

  const repoPath = mkdtempSync(join(tmpdir(), "clobber-idempotent-dispatch-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);
  const roleRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string };
  const agent = agents.create({ workspace_id: ws.id, role_id: roleRow.id, label: "mgr" });

  let spawnN = 0;
  const attach: AttachSessionFn = async (_input): Promise<AttachOutcome> => {
    spawnN++;
    const sessionId = `manager-session-${spawnN}`;
    sessions.create({
      id: sessionId,
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: roleRow.id,
      pid: 4000 + spawnN,
    });
    return { ok: true, agent_id: agent.id, session_id: sessionId, pid: 4000 + spawnN };
  };

  const deps: DispatchDeps = {
    clock,
    agents,
    roles,
    workspaces,
    sessions,
    registry,
    runtimeProvider: claudeRuntimeProvider,
    dispatches,
    attachSession: attach,
    resumeEndedSession: async () => ({
      ok: false,
      status: 409,
      error: "runtime does not support resume" as const,
    }),
    synthesize: defaultSynthesizePrompt,
    dispatcher,
  };

  return {
    deps,
    binding: { agentId: agent.id, roleId: roleRow.id, workspaceId: ws.id },
    notifications,
  };
}

describe("AC2 — distinct-don't-collapse: two sessions → two notification rows", () => {
  it("worker-done for session-A then session-B produces 2 distinct notification rows", async () => {
    const h = makeDispatchHarness();
    const TRIGGER: RoleTrigger = { kind: "worker-done" };

    const payloadA: CompletionWakePayload = {
      ended: [{ sessionId: "worker-session-a", label: "worker-a", summary: "done" }],
    };
    const payloadB: CompletionWakePayload = {
      ended: [{ sessionId: "worker-session-b", label: "worker-b", summary: "done" }],
    };

    await dispatchTrigger(h.deps, h.binding, TRIGGER, payloadA);
    await dispatchTrigger(h.deps, h.binding, TRIGGER, payloadB);

    // Two distinct completion events → two distinct notification rows.
    // Fails if source_id is "worker-done" for both (same logical_key → dedup → 1 row).
    expect(h.notifications.listForAgent(h.binding.agentId)).toHaveLength(2);

    // The two rows carry different provenance (different source_ids after re-grain)
    const rows = h.notifications.listForAgent(h.binding.agentId);
    expect(rows[0]!.provenance.source_id).not.toBe(rows[1]!.provenance.source_id);
  });
});

// ─── AC3 ─────────────────────────────────────────────────────────────────────
// Keep-first: once a notification has advanced to delivered or acked, a
// re-emit of the same logical key must NOT reset its state back to pending.
// Resetting would re-create the storm for the rearmPending path (#574).
describe("AC3 — keep-first: re-emit preserves delivered/acked state, no re-delivery", () => {
  it("emit → deliver → re-emit same key: state stays delivered, transport still called only once", async () => {
    const db = createDatabase(":memory:");
    const { agentId } = seedWorkspace(db);
    const store = createNotificationStore(db);
    const clock = createTestClock(new Date("2026-06-01T09:00:00Z"));
    const dispatcher = createNotificationDispatcher(store, clock);

    const req: CreateNotification = {
      type: "trigger",
      recipient: { kind: "agent", agent_id: agentId },
      priority: "low",
      payload: { body: "wake", tag: { kind: "trigger", attrs: { via: "worker-done" } } },
      provenance: { source_kind: "trigger", source_id: "session-delivered-123" },
    };

    let transportCount = 0;
    const transport = async (n: Notification): Promise<DeliveryOutcome> => {
      transportCount++;
      // Simulate successful delivery
      store.markDelivered(n.id, clock.now().getTime());
      return { action: "spawned" };
    };

    // First emit — creates row and delivers
    const r1 = await dispatcher.emit(req, transport);
    expect(store.get(r1.notification.id)!.state).toBe("delivered");

    // Re-emit same logical key — must not reset state
    const r2 = await dispatcher.emit(req, transport);

    expect(r2.outcome.action).toBe("skipped-duplicate");
    expect(transportCount).toBe(1);

    // The row must still be delivered, not reset to pending
    const row = store.get(r1.notification.id)!;
    expect(row.state).toBe("delivered");

    db.close();
  });

  it("emit → ack → re-emit same key: state stays acked, no re-delivery", async () => {
    const db = createDatabase(":memory:");
    const { agentId } = seedWorkspace(db);
    const store = createNotificationStore(db);
    const clock = createTestClock(new Date("2026-06-01T09:00:00Z"));
    const dispatcher = createNotificationDispatcher(store, clock);

    const req: CreateNotification = {
      type: "trigger",
      recipient: { kind: "agent", agent_id: agentId },
      priority: "low",
      payload: { body: "wake", tag: { kind: "trigger", attrs: { via: "worker-done" } } },
      provenance: { source_kind: "trigger", source_id: "session-acked-456" },
    };

    let transportCount = 0;
    const transport = async (_n: Notification): Promise<DeliveryOutcome> => {
      transportCount++;
      return { action: "queued" };
    };

    const r1 = await dispatcher.emit(req, transport);
    store.markAcked(r1.notification.id, clock.now().getTime());
    expect(store.get(r1.notification.id)!.state).toBe("acked");

    const r2 = await dispatcher.emit(req, transport);

    expect(r2.outcome.action).toBe("skipped-duplicate");
    expect(transportCount).toBe(1);
    expect(store.get(r1.notification.id)!.state).toBe("acked");

    db.close();
  });
});

// ─── AC4 ─────────────────────────────────────────────────────────────────────
// Fall-back-to-unique: absent source_id → null logical_key → always-distinct.
// Un-keyed emitters must never be over-collapsed.
describe("AC4 — fall-back-to-unique: absent source_id → two rows (no dedup)", () => {
  it("two emits with no source_id always produce two distinct rows", async () => {
    const db = createDatabase(":memory:");
    const { agentId } = seedWorkspace(db);
    const store = createNotificationStore(db);
    const clock = createTestClock(new Date("2026-06-01T09:00:00Z"));
    const dispatcher = createNotificationDispatcher(store, clock);

    const req: CreateNotification = {
      type: "trigger",
      recipient: { kind: "agent", agent_id: agentId },
      priority: "low",
      payload: { body: "wake", tag: { kind: "trigger", attrs: { via: "cron" } } },
      provenance: { source_kind: "trigger" }, // no source_id
    };

    let transportCount = 0;
    const transport = async (_n: Notification): Promise<DeliveryOutcome> => {
      transportCount++;
      return { action: "queued" };
    };

    const r1 = await dispatcher.emit(req, transport);
    const r2 = await dispatcher.emit(req, transport);

    // Two distinct rows — un-keyed emits are never collapsed
    expect(store.listForAgent(agentId)).toHaveLength(2);
    expect(transportCount).toBe(2);
    expect(r1.notification.id).not.toBe(r2.notification.id);
    expect(r1.outcome.action).not.toBe("skipped-duplicate");
    expect(r2.outcome.action).not.toBe("skipped-duplicate");

    db.close();
  });
});

// ─── AC5 ─────────────────────────────────────────────────────────────────────
// Non-duplicate-path golden: the non-duplicate path (first emit) must deliver
// byte-for-byte unchanged — no regression introduced by the idempotency gate.
describe("AC5 — non-duplicate-path delivery byte-unchanged", () => {
  it("first emit of a keyed notification delivers normally (outcome, row, state unchanged)", async () => {
    const db = createDatabase(":memory:");
    const { agentId } = seedWorkspace(db);
    const store = createNotificationStore(db);
    const clock = createTestClock(new Date("2026-06-01T09:00:00Z"));
    const dispatcher = createNotificationDispatcher(store, clock);

    const req: CreateNotification = {
      type: "trigger",
      recipient: { kind: "agent", agent_id: agentId },
      priority: "low",
      payload: { body: "first-time wake", tag: { kind: "trigger", attrs: { via: "worker-done" } } },
      provenance: { source_kind: "trigger", source_id: "session-golden-789" },
    };

    let deliveredNotification: Notification | null = null;
    const transport = async (n: Notification): Promise<DeliveryOutcome> => {
      deliveredNotification = n;
      return { action: "spawned", sessionId: "spawned-1" };
    };

    const { notification, outcome } = await dispatcher.emit(req, transport);

    // Delivery action unchanged from before idempotency feature
    expect(outcome.action).toBe("spawned");
    expect(outcome.sessionId).toBe("spawned-1");

    // Transport received the notification with correct fields
    expect(deliveredNotification).not.toBeNull();
    expect(deliveredNotification!.payload.body).toBe("first-time wake");
    expect(deliveredNotification!.provenance.source_id).toBe("session-golden-789");

    // Row advanced to delivered (markDelivered path)
    expect(store.get(notification.id)!.state).toBe("delivered");

    db.close();
  });
});

// ─── AC6 ─────────────────────────────────────────────────────────────────────
// DB-enforced uniqueness: the partial unique index must enforce the constraint
// at the database level, not app-level check-then-write (no TOCTOU). Verified
// by inserting directly into the DB and confirming the constraint fires.
describe("AC6 — DB-enforced uniqueness via partial unique index", () => {
  it("direct SQL insert of duplicate logical_key is rejected by the DB (ON CONFLICT DO NOTHING)", () => {
    const db = createDatabase(":memory:");

    // The idx_notifications_logical_key index must exist on the notifications table
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notifications' AND name='idx_notifications_logical_key'",
      )
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);

    // Direct raw insert confirms DB-level enforcement (not app-level guard)
    db.exec(`
      INSERT INTO notifications
        (id, type, recipient_kind, recipient_agent_id, priority,
         payload_json, provenance_json, metadata_json, state, created_at,
         delivered_at, acked_at, logical_key)
      VALUES
        ('id-1','trigger','agent',NULL,'low','{}','{}','{}','pending',1,NULL,NULL,'test-key'),
        ('id-2','trigger','agent',NULL,'low','{}','{}','{}','pending',2,NULL,NULL,NULL)
    `);

    // Second insert with same logical_key — DO NOTHING, row count stays at 1 for that key
    const r = db
      .prepare(
        `INSERT INTO notifications
           (id, type, recipient_kind, recipient_agent_id, priority,
            payload_json, provenance_json, metadata_json, state, created_at,
            delivered_at, acked_at, logical_key)
         VALUES ('id-3','trigger','agent',NULL,'low','{}','{}','{}','pending',3,NULL,NULL,'test-key')
         ON CONFLICT(logical_key) WHERE logical_key IS NOT NULL DO NOTHING`,
      )
      .run();
    expect(r.changes).toBe(0);

    // NULL logical_key rows are not deduplicated (partial index excludes NULLs)
    const r2 = db
      .prepare(
        `INSERT INTO notifications
           (id, type, recipient_kind, recipient_agent_id, priority,
            payload_json, provenance_json, metadata_json, state, created_at,
            delivered_at, acked_at, logical_key)
         VALUES ('id-4','trigger','agent',NULL,'low','{}','{}','{}','pending',4,NULL,NULL,NULL)
         ON CONFLICT(logical_key) WHERE logical_key IS NOT NULL DO NOTHING`,
      )
      .run();
    expect(r2.changes).toBe(1); // NULL-key insert always succeeds

    db.close();
  });
});
