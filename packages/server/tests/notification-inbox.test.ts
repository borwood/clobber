/**
 * Phase-2 inbox integration tests (#526):
 *   (a) store extensions: listUnackedForUser / listUnackedForAgent / markAcked / listPending
 *   (b) composeUnackedNotifications — non-flushing boot re-dump
 *   (c) rearmPending — survive process boundaries (server-boot + cycle-reseat)
 *   (d) deliver() fold-ins: user→recorded, absent-agent→errored, role-absent→throw
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { claudeRuntimeProvider } from "@clobber/runtime";
import type { CreateNotification, Notification } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createAgentRegistry } from "../src/agent-registry.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import { createNotificationDispatcher, deliver, rearmPending } from "../src/notification-dispatch.ts";
import { composeUnackedNotifications } from "../src/notification-inbox.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { createTestClock } from "../src/clock.ts";
import type { AttachSessionFn, AttachOutcome } from "../src/trigger-attach.ts";
import type { AgentStore } from "../src/agent-store.ts";
import type { RoleStore } from "../src/role-store.ts";
import type { DeliverDeps, RearmPendingDeps } from "../src/notification-dispatch.ts";

const T1 = 1_700_000_000_000;
const T2 = 1_700_000_001_000;
const T3 = 1_700_000_002_000;

function userNotifReq(): CreateNotification {
  return {
    type: "message",
    recipient: { kind: "user" },
    priority: "low",
    payload: { body: "hello user", tag: { kind: "message" } },
    provenance: { source_kind: "message" },
  };
}

function agentNotifReq(agentId: string, body = "you have a notification"): CreateNotification {
  return {
    type: "trigger",
    recipient: { kind: "agent", agent_id: agentId },
    priority: "low",
    payload: { body, tag: { kind: "trigger", attrs: { via: "cron" } } },
    provenance: { source_kind: "trigger" },
  };
}

interface StoreHarness {
  db: ReturnType<typeof createDatabase>;
  store: ReturnType<typeof createNotificationStore>;
  agentId: string;
  workspaceId: string;
}

function makeStoreHarness(): StoreHarness {
  const db = createDatabase(":memory:");
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-inbox-store-"));
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
  return { db, store, agentId: agent.id, workspaceId: ws.id };
}

interface DispatchHarness {
  db: ReturnType<typeof createDatabase>;
  store: ReturnType<typeof createNotificationStore>;
  deliverDeps: DeliverDeps;
  rearmDeps: RearmPendingDeps;
  agentId: string;
  workspaceId: string;
  roleId: string;
  spawnCalls: Parameters<AttachSessionFn>[0][];
  sessions: ReturnType<typeof createSessionStore>;
  registry: ReturnType<typeof createAgentRegistry>;
}

function makeDispatchHarness(attachOverride?: AttachSessionFn): DispatchHarness {
  const db = createDatabase(":memory:");
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-inbox-dispatch-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const clock = createTestClock(new Date("2026-06-06T10:00:00.000Z"));
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const registry = createAgentRegistry();
  const store = createNotificationStore(db);

  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);
  const roleRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string };
  const agent = agents.create({ workspace_id: ws.id, role_id: roleRow.id });

  const spawnCalls: Parameters<AttachSessionFn>[0][] = [];
  let spawnCounter = 0;
  const defaultAttach: AttachSessionFn = async (input) => {
    spawnCalls.push(input);
    spawnCounter += 1;
    const sid = `spawned-session-${spawnCounter}`;
    sessions.create({
      id: sid,
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: roleRow.id,
      pid: 4200 + spawnCounter,
    });
    const ok: AttachOutcome = { ok: true, agent_id: agent.id, session_id: sid, pid: 4200 + spawnCounter };
    return ok;
  };
  const attachSession = attachOverride ?? defaultAttach;

  const deliverDeps: DeliverDeps = {
    agents,
    roles,
    workspaces,
    sessions,
    registry,
    runtimeProvider: claudeRuntimeProvider,
    attachSession,
    resumeEndedSession: async () => ({ ok: false, status: 409, error: "runtime does not support resume" as const }),
  };

  const rearmDeps: RearmPendingDeps = {
    ...deliverDeps,
    store,
    clock,
  };

  return { db, store, deliverDeps, rearmDeps, agentId: agent.id, workspaceId: ws.id, roleId: roleRow.id, spawnCalls, sessions, registry };
}

// ─── (a) Store extensions ────────────────────────────────────────────────────

describe("notification inbox — store extensions", () => {
  it("listUnackedForUser returns pending user notifications", () => {
    const h = makeStoreHarness();
    h.store.create(userNotifReq(), T1);
    h.store.create(userNotifReq(), T2);
    const rows = h.store.listUnackedForUser();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.recipient).toEqual({ kind: "user" });
    h.db.close();
  });

  it("listUnackedForUser returns delivered user notifications", () => {
    const h = makeStoreHarness();
    const n = h.store.create(userNotifReq(), T1);
    h.store.markDelivered(n.id, T2);
    const rows = h.store.listUnackedForUser();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("delivered");
    h.db.close();
  });

  it("listUnackedForUser excludes acked rows", () => {
    const h = makeStoreHarness();
    const n = h.store.create(userNotifReq(), T1);
    h.store.markAcked(n.id, T2);
    const rows = h.store.listUnackedForUser();
    expect(rows).toHaveLength(0);
    h.db.close();
  });

  it("listUnackedForUser does not return agent notifications", () => {
    const h = makeStoreHarness();
    h.store.create(agentNotifReq(h.agentId), T1);
    const rows = h.store.listUnackedForUser();
    expect(rows).toHaveLength(0);
    h.db.close();
  });

  it("markAcked advances pending->acked, stamps acked_at", () => {
    const h = makeStoreHarness();
    const n = h.store.create(userNotifReq(), T1);
    const changed = h.store.markAcked(n.id, T2);
    expect(changed).toBe(true);
    const after = h.store.get(n.id)!;
    expect(after.state).toBe("acked");
    expect(after.acked_at).toBe(T2);
    h.db.close();
  });

  it("markAcked is idempotent — second call returns false, state stays acked", () => {
    const h = makeStoreHarness();
    const n = h.store.create(userNotifReq(), T1);
    h.store.markAcked(n.id, T2);
    const second = h.store.markAcked(n.id, T3);
    expect(second).toBe(false);
    expect(h.store.get(n.id)!.state).toBe("acked");
    h.db.close();
  });

  it("listUnackedForAgent returns pending/delivered agent notifications, not acked", () => {
    const h = makeStoreHarness();
    const n1 = h.store.create(agentNotifReq(h.agentId, "first"), T1);
    const n2 = h.store.create(agentNotifReq(h.agentId, "second"), T2);
    h.store.markDelivered(n2.id, T2);
    // ack n1
    h.store.markAcked(n1.id, T3);
    // Create user notif to confirm it's excluded
    h.store.create(userNotifReq(), T1);

    const rows = h.store.listUnackedForAgent(h.agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(n2.id);
    expect(rows[0]!.state).toBe("delivered");
    h.db.close();
  });

  it("listPending returns only state='pending' rows", () => {
    const h = makeStoreHarness();
    const n1 = h.store.create(agentNotifReq(h.agentId, "first"), T1);
    const n2 = h.store.create(agentNotifReq(h.agentId, "second"), T2);
    h.store.markDelivered(n2.id, T2);
    h.store.create(userNotifReq(), T1);

    const pending = h.store.listPending();
    const ids = pending.map((n) => n.id);
    expect(ids).toContain(n1.id);
    expect(ids).not.toContain(n2.id);
    h.db.close();
  });
});

// ─── (b) composeUnackedNotifications ────────────────────────────────────────

describe("notification inbox — composeUnackedNotifications (non-flushing boot re-dump)", () => {
  it("two un-acked agent notifications appear in composed output", () => {
    const h = makeStoreHarness();
    h.store.create(agentNotifReq(h.agentId, "wake up: job done"), T1);
    h.store.create(agentNotifReq(h.agentId, "reminder: check prs"), T2);

    const output = composeUnackedNotifications(h.agentId, h.store);
    expect(output).toContain("wake up: job done");
    expect(output).toContain("reminder: check prs");
    h.db.close();
  });

  it("composing does NOT mutate notification state (non-flushing)", () => {
    const h = makeStoreHarness();
    h.store.create(agentNotifReq(h.agentId, "stay pending"), T1);

    composeUnackedNotifications(h.agentId, h.store);

    const rows = h.store.listUnackedForAgent(h.agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("pending");
    h.db.close();
  });

  it("zero un-acked notifications => near-silent output (dilution guard)", () => {
    const h = makeStoreHarness();
    const output = composeUnackedNotifications(h.agentId, h.store);
    // Near-silent: should be very short (or empty) when nothing unacked
    expect(output.length).toBeLessThan(100);
    h.db.close();
  });

  it("acked notifications are excluded from the compose output", () => {
    const h = makeStoreHarness();
    const n = h.store.create(agentNotifReq(h.agentId, "already done"), T1);
    h.store.markAcked(n.id, T2);

    const output = composeUnackedNotifications(h.agentId, h.store);
    expect(output).not.toContain("already done");
    h.db.close();
  });
});

// ─── (c) rearmPending ────────────────────────────────────────────────────────

describe("notification inbox — rearmPending (survive process boundaries)", () => {
  it("server-boot: pending row rearms and delivery occurs (spawned)", async () => {
    const h = makeDispatchHarness();
    // Emit with skip-busy path so notification stays pending
    const n = h.store.create(agentNotifReq(h.agentId, "rearm me"), T1);
    // Verify it's pending (no in-memory queue, no session)
    expect(h.store.get(n.id)!.state).toBe("pending");

    await rearmPending(h.rearmDeps);

    // Delivery should have occurred via spawn (agent had no session)
    expect(h.spawnCalls).toHaveLength(1);
    // Row should now be delivered
    expect(h.store.get(n.id)!.state).toBe("delivered");
    h.db.close();
  });

  it("cycle-reseat-boot: rearmPending scoped to agentId only rearms that agent's rows", async () => {
    const db = createDatabase(":memory:");
    const repoPath = mkdtempSync(join(tmpdir(), "clobber-inbox-reseat-"));
    writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
    const clock = createTestClock(new Date("2026-06-06T10:00:00.000Z"));
    const workspaces = createWorkspaceStore(db);
    const roles = createRoleStore(db);
    const agents = createAgentStore(db);
    const sessions = createSessionStore(db);
    const registry = createAgentRegistry();
    const store = createNotificationStore(db);
    const spawnCalls: Parameters<AttachSessionFn>[0][] = [];
    let cnt = 0;

    const ws = workspaces.create({ name: "ws", repo_path: repoPath });
    seedWorkspaceRoles(db, ws.id);
    const roleRow = db
      .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
      .get("manager", ws.id) as { id: string };
    const agent1 = agents.create({ workspace_id: ws.id, role_id: roleRow.id, label: "a1" });
    const agent2 = agents.create({ workspace_id: ws.id, role_id: roleRow.id, label: "a2" });

    const attachSession: AttachSessionFn = async (input) => {
      spawnCalls.push(input);
      cnt += 1;
      const sid = `sid-${cnt}`;
      sessions.create({ id: sid, agent_id: (input as { agent: { id: string } }).agent.id, workspace_id: ws.id, role_id: roleRow.id, pid: 5000 + cnt });
      return { ok: true, agent_id: (input as { agent: { id: string } }).agent.id, session_id: sid, pid: 5000 + cnt };
    };

    const baseDeliverDeps: DeliverDeps = {
      agents,
      roles,
      workspaces,
      sessions,
      registry,
      runtimeProvider: claudeRuntimeProvider,
      attachSession,
      resumeEndedSession: async () => ({ ok: false, status: 409, error: "runtime does not support resume" as const }),
    };
    const rearmDeps: RearmPendingDeps = { ...baseDeliverDeps, store, clock };

    // Both agents have pending notifications
    const n1 = store.create(agentNotifReq(agent1.id, "for agent1"), T1);
    const n2 = store.create(agentNotifReq(agent2.id, "for agent2"), T1);

    // Rearm only agent1 (cycle-reseat scope)
    await rearmPending(rearmDeps, agent1.id);

    // Only agent1's notification was rearmed
    expect(spawnCalls).toHaveLength(1);
    expect(store.get(n1.id)!.state).toBe("delivered");
    // agent2's notification is still pending
    expect(store.get(n2.id)!.state).toBe("pending");
    db.close();
  });

  it("one throwing row does not abort re-arm of remaining rows", async () => {
    // This is batch-isolation: a DB-inconsistent or poison pending notification
    // must not prevent rearming all subsequent rows in the same boot pass.
    const db = createDatabase(":memory:");
    const repoPath = mkdtempSync(join(tmpdir(), "clobber-rearm-batch-"));
    writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
    const clock = createTestClock(new Date("2026-06-06T10:00:00.000Z"));
    const workspaces = createWorkspaceStore(db);
    const roles = createRoleStore(db);
    const agents = createAgentStore(db);
    const sessions = createSessionStore(db);
    const registry = createAgentRegistry();
    const store = createNotificationStore(db);
    let spawnCount = 0;

    const ws = workspaces.create({ name: "ws", repo_path: repoPath });
    seedWorkspaceRoles(db, ws.id);
    const roleRow = db
      .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
      .get("manager", ws.id) as { id: string };
    const goodAgent = agents.create({ workspace_id: ws.id, role_id: roleRow.id, label: "good" });

    const attachSession: AttachSessionFn = async (input) => {
      spawnCount += 1;
      const sid = `sid-${spawnCount}`;
      sessions.create({ id: sid, agent_id: (input as { agent: { id: string } }).agent.id, workspace_id: ws.id, role_id: roleRow.id, pid: 6000 + spawnCount });
      return { ok: true, agent_id: (input as { agent: { id: string } }).agent.id, session_id: sid, pid: 6000 + spawnCount };
    };

    // Inject a roles store whose get() throws to simulate a poison row. The
    // throwing row targets an agent whose role lookup explodes (invariant-breach
    // path). The subsequent good row must still be rearmed.
    let throwNext = false;
    const poisonRoles: RoleStore = {
      ...roles,
      get: (id: string) => {
        if (throwNext) {
          throwNext = false;
          throw new Error("simulated DB corruption on role lookup");
        }
        return roles.get(id);
      },
    };

    const poisonAgent = agents.create({ workspace_id: ws.id, role_id: roleRow.id, label: "poison" });
    // First pending row will hit the throwing role lookup
    const nPoison = store.create(agentNotifReq(poisonAgent.id, "poison body"), T1);
    // Second pending row is healthy and should be rearmed
    const nGood = store.create(agentNotifReq(goodAgent.id, "good body"), T2);

    // Prime the throw for the first deliver() call
    throwNext = true;

    const rearmDeps: RearmPendingDeps = {
      agents,
      roles: poisonRoles,
      workspaces,
      sessions,
      registry,
      runtimeProvider: claudeRuntimeProvider,
      attachSession,
      resumeEndedSession: async () => ({ ok: false, status: 409, error: "runtime does not support resume" as const }),
      store,
      clock,
    };

    // Must not reject — batch-isolation catches the throw and continues
    await expect(rearmPending(rearmDeps)).resolves.toBeUndefined();

    // Poison row stays pending (not delivered, not errored — loop skipped it)
    expect(store.get(nPoison.id)!.state).toBe("pending");
    // Good row was successfully rearmed
    expect(store.get(nGood.id)!.state).toBe("delivered");
    expect(spawnCount).toBe(1);
    db.close();
  });
});

// ─── (d) deliver() fold-ins ──────────────────────────────────────────────────

describe("notification dispatch — deliver() fold-ins", () => {
  it("user recipient: deliver records notification without throw or spawn", async () => {
    const h = makeDispatchHarness();
    const n = h.store.create(userNotifReq(), T1);

    const outcome = await deliver(h.deliverDeps, n, { kind: "drop" });

    // No throw — returns a recorded/queued outcome
    expect(outcome.action).toBe("queued");
    // No spawn occurred
    expect(h.spawnCalls).toHaveLength(0);
    h.db.close();
  });

  it("user high-prio recipient: deliver records with queued action (Phase-3 wake deferred)", async () => {
    const h = makeDispatchHarness();
    const n = h.store.create(
      {
        type: "message",
        recipient: { kind: "user" },
        priority: "high",
        payload: { body: "urgent", tag: { kind: "message" } },
        provenance: { source_kind: "message" },
      },
      T1,
    );

    const outcome = await deliver(h.deliverDeps, n, { kind: "drop" });
    // Phase 2: record only; no out-of-band push (Phase 3)
    expect(outcome.action).toBe("queued");
    expect(h.spawnCalls).toHaveLength(0);
    h.db.close();
  });

  it("absent agent: deliver returns {action:'errored'} with no throw", async () => {
    const h = makeDispatchHarness();
    // Override agents.get to simulate an absent (reaped) agent
    const absentAgents: AgentStore = {
      ...h.deliverDeps.agents,
      get: () => null,
    };
    const n = h.store.create(agentNotifReq(h.agentId, "orphan"), T1);

    const outcome = await deliver({ ...h.deliverDeps, agents: absentAgents }, n, { kind: "drop" });
    expect(outcome.action).toBe("errored");
    expect(outcome.error).toBeDefined();
    // Row stays pending (deliver doesn't mark delivered on errored)
    expect(h.store.get(n.id)!.state).toBe("pending");
    h.db.close();
  });

  it("role absent while agent exists: deliver still throws (invariant breach)", async () => {
    const h = makeDispatchHarness();
    const absentRoles: RoleStore = {
      ...h.deliverDeps.roles,
      get: () => null,
    };
    const n = h.store.create(agentNotifReq(h.agentId, "contract breach"), T1);

    await expect(
      deliver({ ...h.deliverDeps, roles: absentRoles }, n, { kind: "drop" }),
    ).rejects.toThrow();
    h.db.close();
  });

  it("workspace absent while agent exists: deliver still throws (invariant breach)", async () => {
    const h = makeDispatchHarness();
    const absentWorkspaces = {
      ...h.deliverDeps.workspaces,
      get: () => null,
    };
    const n = h.store.create(agentNotifReq(h.agentId, "ws breach"), T1);

    await expect(
      deliver({ ...h.deliverDeps, workspaces: absentWorkspaces as typeof h.deliverDeps.workspaces }, n, { kind: "drop" }),
    ).rejects.toThrow();
    h.db.close();
  });
});
