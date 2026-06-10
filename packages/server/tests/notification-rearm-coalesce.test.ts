/**
 * Real-path tests for category-aware rearm coalescing (#616).
 *
 * The core contract:
 * - transient (trigger/wake): per-recipient latest-only; stale rows are
 *   cancelled, not trickle-delivered. Superseded wakes must never replay.
 * - durable (message/ask): per-recipient deliver-all. Distinct messages must
 *   not be starved by the latest-only filter.
 * - quiet rows: excluded from both paths — drainQuiet owns them.
 * - worker-done waking a sleeping manager: must survive (regression guard).
 *
 * All run through the real deliver() / rearmPending() path — no stubs.
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
import { rearmPending } from "../src/notification-dispatch.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { createTestClock } from "../src/clock.ts";
import type { AttachSessionFn, AttachOutcome } from "../src/trigger-attach.ts";
import type { DeliverDeps, RearmPendingDeps } from "../src/notification-dispatch.ts";

const T0 = 1_700_000_000_000;

interface Harness {
  db: ReturnType<typeof createDatabase>;
  store: ReturnType<typeof createNotificationStore>;
  rearmDeps: RearmPendingDeps;
  managerAgentId: string;
  workerAgentId: string;
  workspaceId: string;
  managerRoleId: string;
  workerRoleId: string;
  sessions: ReturnType<typeof createSessionStore>;
  registry: ReturnType<typeof createAgentRegistry>;
  spawnedSessions: string[];
}

function makeHarness(): Harness {
  const db = createDatabase(":memory:");
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-rearm-coalesce-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const clock = createTestClock(new Date("2026-06-10T12:00:00.000Z"));
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const registry = createAgentRegistry();
  const store = createNotificationStore(db);

  const ws = workspaces.create({ name: "ws-rearm", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);

  const managerRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string };
  const workerRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("worker", ws.id) as { id: string };

  const managerAgent = agents.create({ workspace_id: ws.id, role_id: managerRow.id, label: "mgr" });
  const workerAgent = agents.create({ workspace_id: ws.id, role_id: workerRow.id, label: "wkr" });

  let spawnCounter = 0;
  const spawnedSessions: string[] = [];
  const attachSession: AttachSessionFn = async (input) => {
    spawnCounter += 1;
    const sid = `spawned-${spawnCounter}`;
    spawnedSessions.push(sid);
    sessions.create({
      id: sid,
      agent_id: input.agent.id,
      workspace_id: ws.id,
      role_id: input.role.id,
      pid: 9000 + spawnCounter,
    });
    const ok: AttachOutcome = {
      ok: true,
      agent_id: input.agent.id,
      session_id: sid,
      pid: 9000 + spawnCounter,
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

  const rearmDeps: RearmPendingDeps = { ...deliverDeps, store, clock };

  return {
    db,
    store,
    rearmDeps,
    managerAgentId: managerAgent.id,
    workerAgentId: workerAgent.id,
    workspaceId: ws.id,
    managerRoleId: managerRow.id,
    workerRoleId: workerRow.id,
    sessions,
    registry,
    spawnedSessions,
  };
}

function liveSession(h: Harness, agentId: string, sessionId: string, busy: boolean): PassThrough {
  const stdin = new PassThrough();
  stdin.resume();
  h.sessions.create({
    id: sessionId,
    agent_id: agentId,
    workspace_id: h.workspaceId,
    role_id: h.managerRoleId,
    pid: 5000,
  });
  h.registry.register(sessionId, stdin, () => {}, busy);
  return stdin;
}

function transientReq(agentId: string, body: string, ts: number): CreateNotification {
  return {
    type: "trigger",
    category: "transient",
    recipient: { kind: "agent", agent_id: agentId },
    priority: "high",
    payload: { body, tag: { kind: "trigger", attrs: { via: "worker-done" } } },
    provenance: { source_kind: "trigger" },
    metadata: {},
  };
}

function durableReq(agentId: string, body: string): CreateNotification {
  return {
    type: "message",
    category: "durable",
    recipient: { kind: "agent", agent_id: agentId },
    priority: "high",
    payload: { body, tag: { kind: "message", attrs: { from: "worker-1", token: "tok-1" } } },
    provenance: { source_kind: "message" },
    metadata: {},
  };
}

describe("rearmPending — category-aware coalescing (#616)", () => {
  it("(a) transient: M stale + 1 latest pending → 1 injected, M cancelled, 0 still pending", async () => {
    // The stale-transient cancel contract: when M+1 transient rows accumulate for
    // one recipient, rearmPending must deliver only the latest and cancel the M
    // stale rows so they never trickle-deliver on a future rearm.
    const M = 3;
    const h = makeHarness();
    const writes: Buffer[] = [];
    const stdin = liveSession(h, h.managerAgentId, "live-busy-a1", true);
    stdin.on("data", (c: Buffer) => writes.push(c));

    for (let i = 0; i <= M; i += 1) {
      h.store.create(transientReq(h.managerAgentId, `wake-${i}`, T0 + i * 1000), T0 + i * 1000);
    }
    expect(h.store.listPending()).toHaveLength(M + 1);

    await rearmPending(h.rearmDeps);

    // Only 1 injection (the latest).
    expect(writes).toHaveLength(1);
    // The latest body must be what landed.
    expect(Buffer.concat(writes).toString("utf8")).toContain(`wake-${M}`);
    // Stale rows are cancelled, not pending.
    const pending = h.store.listPending();
    expect(pending).toHaveLength(0);
    const all = h.store.listForAgent(h.managerAgentId);
    const cancelled = all.filter((n) => n.state === "cancelled");
    expect(cancelled).toHaveLength(M);

    h.db.close();
  });

  it("(b) durable: N distinct pending messages → all N delivered, none cancelled", async () => {
    // Deliver-all contract for durable rows: distinct messages must not be
    // starved by the latest-only filter. Each message must reach the recipient.
    const N = 3;
    const h = makeHarness();
    const writes: Buffer[] = [];
    const stdin = liveSession(h, h.managerAgentId, "live-busy-b1", true);
    stdin.on("data", (c: Buffer) => writes.push(c));

    for (let i = 0; i < N; i += 1) {
      h.store.create(durableReq(h.managerAgentId, `message-${i}`), T0 + i * 1000);
    }
    expect(h.store.listPending()).toHaveLength(N);

    await rearmPending(h.rearmDeps);

    // All N messages injected.
    expect(writes).toHaveLength(N);
    const allText = writes.map((b) => b.toString("utf8")).join("");
    for (let i = 0; i < N; i += 1) {
      expect(allText).toContain(`message-${i}`);
    }
    // No cancelled rows — durable rows must not be cancelled.
    const all = h.store.listForAgent(h.managerAgentId);
    expect(all.filter((n) => n.state === "cancelled")).toHaveLength(0);
    // All delivered, none pending.
    expect(h.store.listPending()).toHaveLength(0);

    h.db.close();
  });

  it("(c) mixed: durable + transient pending for same recipient → all durable + only latest transient", async () => {
    // Integration: both categories can coexist for the same recipient. Durable
    // must all land; transient must coalesce to latest-only + stale cancelled.
    const h = makeHarness();
    const writes: Buffer[] = [];
    const stdin = liveSession(h, h.managerAgentId, "live-busy-c1", true);
    stdin.on("data", (c: Buffer) => writes.push(c));

    // 2 durable messages
    h.store.create(durableReq(h.managerAgentId, "msg-alpha"), T0);
    h.store.create(durableReq(h.managerAgentId, "msg-beta"), T0 + 1000);
    // 2 stale + 1 latest transient
    h.store.create(transientReq(h.managerAgentId, "wake-old-1", T0 + 2000), T0 + 2000);
    h.store.create(transientReq(h.managerAgentId, "wake-old-2", T0 + 3000), T0 + 3000);
    h.store.create(transientReq(h.managerAgentId, "wake-latest", T0 + 4000), T0 + 4000);

    await rearmPending(h.rearmDeps);

    // 3 injections: 2 durable + 1 transient (latest)
    expect(writes).toHaveLength(3);
    const allText = writes.map((b) => b.toString("utf8")).join("");
    expect(allText).toContain("msg-alpha");
    expect(allText).toContain("msg-beta");
    expect(allText).toContain("wake-latest");
    // The stale transients must be cancelled
    const all = h.store.listForAgent(h.managerAgentId);
    const cancelled = all.filter((n) => n.state === "cancelled");
    expect(cancelled).toHaveLength(2);
    // Stale transient bodies match
    const cancelledBodies = cancelled.map((n) => n.payload.body).sort();
    expect(cancelledBodies).toEqual(["wake-old-1", "wake-old-2"]);

    h.db.close();
  });

  it("(d) quiet rows are not cancelled or delivered by rearm (drainQuiet owns them)", async () => {
    // Quiet rows are a separate delivery channel. rearmPending must leave them
    // alone — they are neither coalesced-cancelled nor injected here.
    const h = makeHarness();
    const writes: Buffer[] = [];
    const stdin = liveSession(h, h.managerAgentId, "live-busy-d1", true);
    stdin.on("data", (c: Buffer) => writes.push(c));

    // 2 quiet transient rows
    h.store.create(
      { ...transientReq(h.managerAgentId, "quiet-wake-1", T0), delivery_mode: "quiet" },
      T0,
    );
    h.store.create(
      { ...transientReq(h.managerAgentId, "quiet-wake-2", T0 + 1000), delivery_mode: "quiet" },
      T0 + 1000,
    );
    // 1 normal transient (should still coalesce normally)
    h.store.create(transientReq(h.managerAgentId, "normal-wake", T0 + 2000), T0 + 2000);

    await rearmPending(h.rearmDeps);

    // Only 1 injection (the normal transient — quiet ones untouched).
    expect(writes).toHaveLength(1);
    expect(Buffer.concat(writes).toString("utf8")).toContain("normal-wake");
    // The 2 quiet rows remain pending (not cancelled, not delivered).
    const pending = h.store.listPending();
    expect(pending).toHaveLength(2);
    expect(pending.every((n) => n.delivery_mode === "quiet")).toBe(true);

    h.db.close();
  });

  it("(e) transient rearm for a sleeping persistent manager → spawned (wake path preserved)", async () => {
    // Regression guard: the category-aware path must not break the worker-done
    // → manager wake flow. A transient pending notification for a persistent
    // agent with no active session must still spawn/resume it.
    const h = makeHarness();

    h.store.create(
      transientReq(h.managerAgentId, "worker-1 done", T0),
      T0,
    );
    expect(h.store.listPending()).toHaveLength(1);

    await rearmPending(h.rearmDeps);

    // The manager must have been spawned.
    expect(h.spawnedSessions).toHaveLength(1);
    // The notification must be marked delivered.
    const pending = h.store.listPending();
    expect(pending).toHaveLength(0);

    h.db.close();
  });

  it("(f) transient rearm for a sleeping non-persistent (worker) recipient → stale cancelled, latest stays pending (no spawn)", async () => {
    // Ephemeral branch: stale transient cancellation applies to non-persistent
    // recipients too. The latest still reaches deliver() and returns queued
    // (non-persistent never auto-wakes) — no spawn, but the latest stays as
    // the single live row while stale rows are cancelled clean.
    const h = makeHarness();

    h.store.create(transientReq(h.workerAgentId, "wake-stale-1", T0), T0);
    h.store.create(transientReq(h.workerAgentId, "wake-stale-2", T0 + 1000), T0 + 1000);
    h.store.create(transientReq(h.workerAgentId, "wake-latest", T0 + 2000), T0 + 2000);
    expect(h.store.listPending()).toHaveLength(3);

    await rearmPending(h.rearmDeps);

    // No spawn — ephemeral role never auto-wakes.
    expect(h.spawnedSessions).toHaveLength(0);
    // The 2 stale rows must be cancelled.
    const all = h.store.listForAgent(h.workerAgentId);
    expect(all.filter((n) => n.state === "cancelled")).toHaveLength(2);
    // The latest is still pending (deliver() returned queued for non-persistent).
    const pending = h.store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.payload.body).toBe("wake-latest");

    h.db.close();
  });

  it("(g) transient rearm for sleeping persistent manager with shutdown tip → resumed (both #612 branches pinned)", async () => {
    // Pin the resume branch of the sleeping-manager wake path. When a shutdown
    // tip exists AND resumeEndedSession succeeds, rearm must mark the row
    // delivered with action=resumed (not spawned). The spawn path is covered
    // by test (e); this covers the resume path so both branches are exercised.
    const h = makeHarness();

    // Seed a shutdown-tip session (was_live_at_shutdown=1) so deliver() takes
    // the resume branch before falling through to fresh-spawn.
    const tipId = "tip-session-1";
    h.sessions.create({
      id: tipId,
      agent_id: h.managerAgentId,
      workspace_id: h.workspaceId,
      role_id: h.managerRoleId,
      pid: 7777,
    });
    h.sessions.markEnded(tipId);
    h.sessions.markWasLiveAtShutdown(tipId);

    // Build deps with a resumeEndedSession that succeeds.
    const resumedSessions: string[] = [];
    const rearmWithResume: RearmPendingDeps = {
      ...h.rearmDeps,
      resumeEndedSession: async (input) => {
        resumedSessions.push(input.sessionId);
        // The resumed session needs to exist in the DB so audit FKs resolve.
        h.sessions.create({
          id: "resumed-1",
          agent_id: h.managerAgentId,
          workspace_id: h.workspaceId,
          role_id: h.managerRoleId,
          pid: 7778,
        });
        return { ok: true, session_id: "resumed-1", pid: 7778 };
      },
    };

    h.store.create(transientReq(h.managerAgentId, "worker-done resume", T0), T0);

    await rearmPending(rearmWithResume);

    // resumeEndedSession was called (not attachSession).
    expect(resumedSessions).toHaveLength(1);
    expect(resumedSessions[0]).toBe(tipId);
    expect(h.spawnedSessions).toHaveLength(0);
    // Row is delivered.
    expect(h.store.listPending()).toHaveLength(0);
    const all = h.store.listForAgent(h.managerAgentId);
    expect(all[0]!.state).toBe("delivered");

    h.db.close();
  });
});
