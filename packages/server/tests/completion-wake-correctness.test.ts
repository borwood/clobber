import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { makeRepoFixture, type RepoFixture } from "./repo-fixture.ts";
import {
  buildHarness,
  teardown,
  bootManager,
  spawnWorker,
  postHook,
  postStatus,
  type Harness,
} from "./_completion-wake-harness.ts";

let repo: RepoFixture;
beforeEach(() => {
  repo = makeRepoFixture("clobber-completion-wake-correctness-");
});
afterEach(() => {
  repo.cleanup();
});

function workerDoneDispatches(h: Harness, agentId: string) {
  return h.dispatches.listForAgent(agentId).filter((d) => d.trigger_kind === "worker-done");
}

describe("completion-wake correctness (#619 + #620)", () => {
  it("(a) persistent agent posts status=done → no worker-done fires", async () => {
    // #619 Fix 1: onWorkerDone must gate on the poster's role being ephemeral.
    // A persistent manager posting `clobber status done` must NOT trigger a
    // worker-done wake — not even to itself.
    const h = buildHarness(new Date("2026-06-10T10:00:00.000Z"));
    const boot = await bootManager(h, repo.path, [{ kind: "worker-done" }]);

    const managerToken = h.tokens.mint(boot.managerSessionId);
    const res = await h.server.inject({
      method: "POST",
      url: "/agent/status",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { state: "done", summary: "all workers finished" },
    });
    expect(res.statusCode).toBe(200);

    const dispatches = workerDoneDispatches(h, boot.managerAgentId);
    expect(dispatches.length).toBe(0);

    await teardown(h);
  });

  it("(b) ephemeral done → manager receives wake, finisher agent does not", async () => {
    // Happy-path correctness after fixes: an ephemeral worker posting done fires
    // the worker-done wake to legitimate registrants (the manager) but not to the
    // finisher itself. Defense against self-dispatch regression (#619 Fix 2).
    const h = buildHarness(new Date("2026-06-10T10:00:00.000Z"));
    const boot = await bootManager(h, repo.path, [{ kind: "worker-done" }]);
    await postHook(h, boot.managerSessionId, "Stop");
    h.spawns[0]!.writes.length = 0;

    const worker = await spawnWorker(h, boot.workspaceId, "issue-619b");
    await postStatus(h, worker, "done", "PR opened");

    const managerDispatches = workerDoneDispatches(h, boot.managerAgentId);
    expect(managerDispatches.length).toBe(1);
    expect(managerDispatches[0]!.dispatch_outcome).toBe("injected");

    const workerDispatches = workerDoneDispatches(h, worker.agentId);
    expect(workerDispatches.length).toBe(0);

    await teardown(h);
  });

  it("(c) re-tasked worker — second done on same session emits a second dispatch", async () => {
    // #620: logical_key must include a per-completion discriminator so the
    // second done from a re-tasked worker is NOT collapsed by ON CONFLICT dedup.
    const h = buildHarness(new Date("2026-06-10T10:00:00.000Z"));
    const boot = await bootManager(h, repo.path, [{ kind: "worker-done" }]);
    // Manager busy (write-through injection path — no Stop needed).

    const worker = await spawnWorker(h, boot.workspaceId, "issue-620-retask");

    await postStatus(h, worker, "done", "PR #100 opened");
    const after1 = workerDoneDispatches(h, boot.managerAgentId);
    expect(after1.length).toBe(1);
    expect(after1[0]!.dispatch_outcome).toBe("injected");

    // Worker re-tasked on the same session: goes back to working, then done again.
    // The intermediate "working" post resets prevStatus so the second done fires.
    await postStatus(h, worker, "working", "assigned PR #200");
    await postStatus(h, worker, "done", "PR #200 opened");
    const after2 = workerDoneDispatches(h, boot.managerAgentId);
    // listForAgent is newest-first; [0] is the second done.
    expect(after2.length).toBe(2);
    expect(after2[0]!.dispatch_outcome).toBe("injected");

    await teardown(h);
  });

  it("(d) double-post — two rapid HTTP done posts → exactly one notification", async () => {
    // #620 HIGH regression guard: the route-level gate (prevStatus?.state !== "done")
    // skips onWorkerDone on the second rapid post so a network retry or accidental
    // re-send produces only one dispatch and one notification for the manager.
    // Tests through the real HTTP route (not via notifications.create directly).
    const h = buildHarness(new Date("2026-06-10T10:00:00.000Z"));
    const boot = await bootManager(h, repo.path, [{ kind: "worker-done" }]);

    const worker = await spawnWorker(h, boot.workspaceId, "issue-620-double-post");
    await postStatus(h, worker, "done", "PR opened");
    await postStatus(h, worker, "done", "PR opened again"); // rapid retry / double-send

    const dispatches = workerDoneDispatches(h, boot.managerAgentId);
    expect(dispatches.length).toBe(1);

    const count = (
      h.db
        .prepare(
          "SELECT COUNT(*) as c FROM notifications WHERE recipient_agent_id = ? AND state != 'cancelled'",
        )
        .get(boot.managerAgentId) as { c: number }
    ).c;
    expect(count).toBe(1);

    await teardown(h);
  });

  it("(e) sleeping manager (no live session) — worker-done notification is queued", async () => {
    // Regression guard for the sleeping-manager path post-#619/#620: worker-done
    // must reach the manager even when the manager has no live session.
    // dispatchTrigger creates the notification synchronously (store.create runs
    // before deliver's async spawn), so we can assert on it without draining.
    const h = buildHarness(new Date("2026-06-10T10:00:00.000Z"));
    const boot = await bootManager(h, repo.path, [{ kind: "worker-done" }]);

    // End the manager session — it is now sleeping (no active session).
    await postHook(h, boot.managerSessionId, "SessionEnd");

    const worker = await spawnWorker(h, boot.workspaceId, "sleeping-manager-test");
    await postStatus(h, worker, "done", "PR opened");

    // store.create is synchronous inside dispatcher.emit, so the notification row
    // exists immediately after the route handler returns — no drain needed.
    const notifCount = (
      h.db
        .prepare(
          "SELECT COUNT(*) as c FROM notifications WHERE recipient_agent_id = ? AND state != 'cancelled'",
        )
        .get(boot.managerAgentId) as { c: number }
    ).c;
    expect(notifCount).toBe(1);

    // Drain the void fire() chain before teardown to prevent DB-closed errors
    // from the async deliver/spawn path still in-flight.
    await new Promise<void>((r) => setTimeout(r, 50));
    await teardown(h);
  });
});
