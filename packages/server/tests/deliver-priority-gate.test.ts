/**
 * Real-path tests for deliver() priority+persistence gate (#605 / #424 Phase 3).
 *
 * Four load-bearing scenarios from the ratified recipient-lifecycle table:
 * (a) persistent+asleep+low → queued (no spawn, no resume).
 * (b) ephemeral+ended+any → queued (ephemeral never auto-wakes).
 * (c) persistent+asleep+high → spawned (the existing wake path must survive).
 * (d) worker-done trigger to a session-less persistent manager → spawned, not
 *     queued (completion-wake must be re-graded to high so the new gate lets it
 *     through).
 *
 * All run through the real deliver() / dispatchTrigger() path — no stubbed
 * recipient-state routers (#605 AC).
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { deliver, rearmPending, createNotificationDispatcher } from "../src/notification-dispatch.ts";
import { dispatchTrigger } from "../src/trigger-dispatch.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { createTestClock, type TestClock } from "../src/clock.ts";
import { defaultSynthesizePrompt } from "../src/trigger-synthesize.ts";
import type { AttachSessionFn, AttachOutcome } from "../src/trigger-attach.ts";
import type { DeliverDeps, RearmPendingDeps } from "../src/notification-dispatch.ts";
import type { DispatchDeps } from "../src/trigger-dispatch.ts";
import type { CompletionWakePayload } from "../src/completion-wake.ts";

const T1 = 1_700_000_000_000;

interface Harness {
  db: ReturnType<typeof createDatabase>;
  store: ReturnType<typeof createNotificationStore>;
  clock: TestClock;
  deliverDeps: DeliverDeps;
  dispatchDeps: DispatchDeps;
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
  const repoPath = mkdtempSync(join(tmpdir(), "clobber-priority-gate-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const clock = createTestClock(new Date("2026-06-10T12:00:00.000Z"));
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const registry = createAgentRegistry();
  const store = createNotificationStore(db);
  const dispatches = createTriggerDispatchStore(db);

  const ws = workspaces.create({ name: "ws-gate", repo_path: repoPath });
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
    const stdin = new PassThrough();
    stdin.resume();
    sessions.create({
      id: sid,
      agent_id: input.agent.id,
      workspace_id: ws.id,
      role_id: input.role.id,
      pid: 8000 + spawnCounter,
    });
    const ok: AttachOutcome = {
      ok: true,
      agent_id: input.agent.id,
      session_id: sid,
      pid: 8000 + spawnCounter,
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

  const dispatcher = createNotificationDispatcher(store, clock);

  const dispatchDeps: DispatchDeps = {
    clock,
    agents,
    roles,
    workspaces,
    sessions,
    registry,
    runtimeProvider: claudeRuntimeProvider,
    dispatches,
    attachSession,
    resumeEndedSession: async () => ({
      ok: false,
      status: 409,
      error: "runtime does not support resume" as const,
    }),
    dispatcher,
    synthesize: defaultSynthesizePrompt,
  };

  return {
    db,
    store,
    clock,
    deliverDeps,
    dispatchDeps,
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

function makeNotif(
  h: Harness,
  agentId: string,
  priority: "high" | "low",
): ReturnType<typeof h.store.create>["notification"] {
  const req: CreateNotification = {
    type: "trigger",
    category: "transient",
    recipient: { kind: "agent", agent_id: agentId },
    priority,
    payload: { body: "test-wake", tag: { kind: "trigger", attrs: { via: "worker-done" } } },
    provenance: { source_kind: "trigger" },
    metadata: {},
  };
  return h.store.create(req, T1).notification;
}

describe("deliver() priority+persistence gate (#605)", () => {
  it("(a) low-priority to persistent-asleep agent → queued, no spawn", async () => {
    // The gate must block low-priority from waking a sleeping persistent agent.
    // Pre-fix: deliver() would spawn regardless of priority → this test fails.
    const h = makeHarness();
    const n = makeNotif(h, h.managerAgentId, "low");

    const outcome = await deliver(h.deliverDeps, n, { kind: "drop" });

    expect(outcome.action).toBe("queued");
    expect(h.spawnedSessions).toHaveLength(0);

    h.db.close();
  });

  it("(b) any-priority to ephemeral-ended agent → queued, no spawn", async () => {
    // Ephemeral agents must never be auto-woken. A non-persistent (worker)
    // role with no active session should always queue, regardless of priority.
    // Pre-fix: deliver() would spawn a fresh session → this test fails.
    const h = makeHarness();
    // High priority to prove it's not priority but persistence that decides.
    const n = makeNotif(h, h.workerAgentId, "high");

    const outcome = await deliver(h.deliverDeps, n, { kind: "drop" });

    expect(outcome.action).toBe("queued");
    expect(h.spawnedSessions).toHaveLength(0);

    h.db.close();
  });

  it("(c) high-priority to persistent-asleep agent → spawned (wake path survives)", async () => {
    // The gate must let high+persistent through to the existing resume-or-spawn
    // path. This is a regression guard: the gate must not block valid wakes.
    const h = makeHarness();
    const n = makeNotif(h, h.managerAgentId, "high");

    const outcome = await deliver(h.deliverDeps, n, { kind: "drop" });

    expect(outcome.action).toBe("spawned");
    expect(h.spawnedSessions).toHaveLength(1);

    h.db.close();
  });

  it("(d) worker-done trigger to session-less manager → spawned (completion-wake re-graded high)", async () => {
    // End-to-end: dispatchTrigger(worker-done) must still wake a session-less
    // persistent manager after the priority gate lands in deliver().
    // Pre-fix (gate only, no re-grade): priority stays low → manager gets queued.
    // Post-fix (gate + re-grade): priority is high → manager gets spawned.
    const h = makeHarness();

    const wakePayload: CompletionWakePayload = {
      ended: [{ sessionId: "wkr-s1", label: "issue-605", summary: "PR opened, gate green" }],
    };

    const landed = await dispatchTrigger(
      h.dispatchDeps,
      {
        agentId: h.managerAgentId,
        roleId: h.managerRoleId,
        workspaceId: h.workspaceId,
      },
      { kind: "worker-done" },
      wakePayload,
    );

    expect(landed).toBe(true);

    const rows = h.dispatchDeps.dispatches.listForAgent(h.managerAgentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dispatch_outcome).toBe("spawned");
    expect(h.spawnedSessions).toHaveLength(1);

    h.db.close();
  });

  it("(e) rearmPending on a queued low-priority row → still pending, no spawn, no duplicate row", async () => {
    // Load-bearing invariant: rearmPending must not bypass the gate. A queued
    // low-priority notification for an asleep persistent agent must survive
    // rearmPending un-delivered (stays pending) and un-duplicated (exactly 1 row).
    const h = makeHarness();
    const rearmDeps: RearmPendingDeps = { ...h.deliverDeps, store: h.store, clock: h.clock, resolveOwner: () => null, agentMessages: createAgentMessageStore(h.db) };

    const n = makeNotif(h, h.managerAgentId, "low");
    expect(h.store.listPending()).toHaveLength(1);

    await rearmPending(rearmDeps);

    // Row must still be pending — the gate re-fires and returns queued again.
    expect(h.store.get(n.id)!.state).toBe("pending");
    // No spawn occurred.
    expect(h.spawnedSessions).toHaveLength(0);
    // Exactly 1 row — rearm must not insert a duplicate.
    expect(h.store.listPending()).toHaveLength(1);

    h.db.close();
  });
});
