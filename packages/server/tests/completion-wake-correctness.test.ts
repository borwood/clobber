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

    // Worker re-tasked on the same session, second completion.
    await postStatus(h, worker, "done", "PR #200 opened");
    const after2 = workerDoneDispatches(h, boot.managerAgentId);
    // listForAgent is newest-first; [0] is the second done.
    expect(after2.length).toBe(2);
    expect(after2[0]!.dispatch_outcome).toBe("injected");

    await teardown(h);
  });

  it("(d) true duplicate — same completion fired twice → second emission deduped", async () => {
    // #620 regression guard: after the per-completion re-grain, a genuine
    // double-emission of the SAME completion (same status log row → same
    // completionId → same logical_key) must still be deduplicated.
    const h = buildHarness(new Date("2026-06-10T10:00:00.000Z"));
    const boot = await bootManager(h, repo.path, [{ kind: "worker-done" }]);

    const worker = await spawnWorker(h, boot.workspaceId, "issue-620-dedup");
    await postStatus(h, worker, "done", "PR opened");

    // Fetch the logical_key that the scheduler stored for this notification.
    const notifRow = h.db
      .prepare(
        "SELECT logical_key FROM notifications WHERE recipient_agent_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(boot.managerAgentId) as { logical_key: string | null } | null;
    expect(notifRow).not.toBeNull();
    expect(notifRow!.logical_key).not.toBeNull();

    // Reverse-engineer the source_id: logical_key = "trigger:<source_id>:<recipientAgentId>"
    const lk = notifRow!.logical_key!;
    const sourceId = lk.slice("trigger:".length, lk.length - boot.managerAgentId.length - 1);
    expect(sourceId.startsWith("worker-done:")).toBe(true);

    // Simulate the double-emission by attempting to insert a notification with the
    // identical provenance. The notification store's ON CONFLICT gate must return
    // created=false (skipped-duplicate).
    const { created } = h.notifications.create(
      {
        type: "trigger",
        category: "transient",
        recipient: { kind: "agent", agent_id: boot.managerAgentId },
        priority: "high",
        payload: {
          body: "duplicate fire",
          tag: { kind: "trigger", attrs: { via: "worker-done" } },
        },
        provenance: { source_kind: "trigger", source_id: sourceId },
        metadata: {},
      },
      h.clock.now().getTime() + 1,
    );
    expect(created).toBe(false);

    // Only 1 non-cancelled notification row must exist for the manager.
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
});
