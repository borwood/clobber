/**
 * Real-path tests for write-through delivery (#573).
 *
 * Three load-bearing assertions per the acceptance criteria:
 * (a) A busy live recipient → injected, not skipped-busy (write-through).
 * (b) N completions while busy → N native wakes (no coalescing — pins the
 *     behavior change: each completion is a real, independently delivered event).
 * (c) rearmPending with M pending rows for one busy recipient → exactly 1 inject
 *     (bounded coalesce-per-recipient), proving write-through does not trade
 *     strand → storm.
 *
 * All three run against a real PassThrough stdin, not a stubbed receiver (the
 * #367 bar: bytes land on the stream, no clobber-side gating).
 */
import { describe, it, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeRuntimeProvider } from "@clobber/runtime";
import type { CreateNotification } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createAgentRegistry } from "../src/agent-registry.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import { createAgentMessageStore } from "../src/agent-message-store.ts";
import { deliver, rearmPending } from "../src/notification-dispatch.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { createTestClock } from "../src/clock.ts";
import type { AttachSessionFn, AttachOutcome } from "../src/trigger-attach.ts";
import type { DeliverDeps, RearmPendingDeps } from "../src/notification-dispatch.ts";

const T1 = 1_700_000_000_000;
const T2 = 1_700_000_001_000;
const T3 = 1_700_000_002_000;

function agentNotifReq(agentId: string, body = "wake-kick: worker done"): CreateNotification {
  return {
    type: "trigger",
    category: "transient",
    recipient: { kind: "agent", agent_id: agentId },
    priority: "low",
    payload: { body, tag: { kind: "trigger", attrs: { via: "worker-done" } } },
    provenance: { source_kind: "trigger" },
  };
}

interface Harness {
  db: ReturnType<typeof createDatabase>;
  store: ReturnType<typeof createNotificationStore>;
  deliverDeps: DeliverDeps;
  rearmDeps: RearmPendingDeps;
  agentId: string;
  workspaceId: string;
  roleId: string;
  sessions: ReturnType<typeof createSessionStore>;
  registry: ReturnType<typeof createAgentRegistry>;
}

function makeHarness(): Harness {
  const db = createDatabase(":memory:");
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-writethrough-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const clock = createTestClock(new Date("2026-06-08T12:00:00.000Z"));
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
  const agent = agents.create({ workspace_id: ws.id, role_id: roleRow.id, label: "mgr-1" });

  let spawnCounter = 0;
  const attachSession: AttachSessionFn = async (input) => {
    spawnCounter += 1;
    const sid = `spawned-${spawnCounter}`;
    sessions.create({
      id: sid,
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: roleRow.id,
      pid: 7000 + spawnCounter,
    });
    const ok: AttachOutcome = {
      ok: true,
      agent_id: agent.id,
      session_id: sid,
      pid: 7000 + spawnCounter,
    };
    return ok;
  };

  const deliverDeps: DeliverDeps = {
    agents,
    roles,
    workspaces,
    sessions,
    registry,
    runtimeProvider: claudeRuntimeProvider,
    attachSession,
    resumeEndedSession: async () => ({
      ok: false,
      status: 409,
      error: "runtime does not support resume" as const,
    }),
  };

  const rearmDeps: RearmPendingDeps = { ...deliverDeps, store, clock, resolveOwner: () => null, agentMessages: createAgentMessageStore(db) };

  return {
    db,
    store,
    deliverDeps,
    rearmDeps,
    agentId: agent.id,
    workspaceId: ws.id,
    roleId: roleRow.id,
    sessions,
    registry,
  };
}

function liveSession(h: Harness, sessionId: string, busy: boolean): PassThrough {
  const stdin = new PassThrough();
  stdin.resume();
  h.sessions.create({
    id: sessionId,
    agent_id: h.agentId,
    workspace_id: h.workspaceId,
    role_id: h.roleId,
    pid: 5000,
  });
  h.registry.register(sessionId, stdin, () => {}, busy);
  return stdin;
}

describe("notification write-through (#573) — real-path tests", () => {
  it("(a) busy live recipient → injected not skipped-busy, bytes land on stdin", async () => {
    // The core bug: deliver() gated on live.busy and returned skipped-busy for a
    // persistent recipient whose session is in-flight at boot. Write-through
    // removes the busy gate so a busy-but-alive recipient gets the notification.
    const h = makeHarness();
    const writes: Buffer[] = [];
    const stdin = liveSession(h, "live-busy-a1", true); // busy=true
    stdin.on("data", (c: Buffer) => writes.push(c));

    const { notification: n } = h.store.create(agentNotifReq(h.agentId, "wake-kick: worker-a done"), T1);
    const outcome = await deliver(h.deliverDeps, n, { kind: "drop" });

    // Must inject, not skip.
    expect(outcome.action).toBe("injected");
    expect(outcome.sessionId).toBe("live-busy-a1");

    // Bytes must land on the real stdin stream — the #367 bar.
    const text = Buffer.concat(writes).toString("utf8");
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("wake-kick: worker-a done");

    h.db.close();
  });

  it("(b) N completions while busy → N native wakes, no coalescing (pins AC#4)", async () => {
    // Behavior change: the old path coalesced N completions into 1 flush-on-idle.
    // Write-through replaces that with N honest injections — each completion is a
    // real event that the recipient's native stdin queue serializes (#367, 14/14).
    // This test pins the new behavior so the change is intentional, not accidental.
    const N = 3;
    const h = makeHarness();
    const writes: Buffer[] = [];
    const stdin = liveSession(h, "live-busy-b1", true); // busy=true, stays busy
    stdin.on("data", (c: Buffer) => writes.push(c));

    for (let i = 0; i < N; i += 1) {
      const { notification: n } = h.store.create(agentNotifReq(h.agentId, `worker-${i} done`), T1 + i * 1000);
      const outcome = await deliver(h.deliverDeps, n, { kind: "drop" });
      expect(outcome.action).toBe("injected");
    }

    // N writes landed on stdin — one per completion, not one coalesced wake.
    expect(writes.length).toBe(N);
    const allText = writes.map((b) => b.toString("utf8")).join("");
    for (let i = 0; i < N; i += 1) {
      expect(allText).toContain(`worker-${i} done`);
    }

    h.db.close();
  });

  it("(c) rearmPending with M pending rows for one busy recipient → 1 inject not M (bounded)", async () => {
    // The storm guard: if write-through injected every pending row on boot/cycle,
    // an accumulated backlog would hit stdin all at once. rearmPending must
    // coalesce-per-recipient: 1 injection (the latest), M-1 stale rows cancelled
    // (#616 category-aware gate). Cancelled rows never trickle-deliver on future
    // rearms — storm averted and stale suppressed.
    const M = 4;
    const h = makeHarness();
    const writes: Buffer[] = [];
    const stdin = liveSession(h, "live-busy-c1", true); // busy live
    stdin.on("data", (c: Buffer) => writes.push(c));

    // Seed M pending rows for the same recipient (simulates accumulated backlog).
    for (let i = 0; i < M; i += 1) {
      h.store.create(agentNotifReq(h.agentId, `backlog-entry-${i}`), T1 + i * 1000);
    }
    expect(h.store.listPending()).toHaveLength(M);

    await rearmPending(h.rearmDeps);

    // Exactly 1 injection — not M. Storm averted.
    expect(writes.length).toBe(1);
    // 0 pending: 1 delivered (the latest), M-1 cancelled (the stale transients).
    expect(h.store.listPending()).toHaveLength(0);
    const all = h.store.listForAgent(h.agentId);
    expect(all.filter((n) => n.state === "delivered")).toHaveLength(1);
    expect(all.filter((n) => n.state === "cancelled")).toHaveLength(M - 1);

    h.db.close();
  });
});
