import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { makeRepoFixture, type RepoFixture } from "./repo-fixture.ts";
import {
  buildHarness,
  teardown,
  bootManager,
  spawnWorker,
  postHook,
  postStatus,
  lastInjectedContent,
} from "./_completion-wake-harness.ts";

let repo: RepoFixture;
beforeEach(() => {
  repo = makeRepoFixture("clobber-worker-done-");
});
afterEach(() => {
  repo.cleanup();
});

describe("worker-done trigger — worker's `clobber status done` wakes the manager", () => {
  it("(a) worker posts status=done while manager idle → manager woken with the done summary", async () => {
    const h = buildHarness(new Date("2026-05-26T09:00:00.000Z"));
    const boot = await bootManager(h, repo.path, [{ kind: "worker-done" }]);

    // Manager goes idle so the wake injects rather than enqueues.
    await postHook(h, boot.managerSessionId, "Stop");
    h.spawns[0]!.writes.length = 0;

    const worker = await spawnWorker(h, boot.workspaceId, "issue-240");
    // The worker opens a PR and never ends — it declares done and idles.
    await postStatus(h, worker, "done", "opened PR #999, local gate green");

    const workerDone = h.dispatches
      .listForAgent(boot.managerAgentId)
      .filter((r) => r.trigger_kind === "worker-done");
    expect(workerDone.length).toBe(1);
    expect(workerDone[0]!.dispatch_outcome).toBe("injected");

    const content = lastInjectedContent(h.spawns[0]!);
    expect(content).toContain("issue-240");
    expect(content).toContain("finished");
    expect(content).toContain("opened PR #999, local gate green");

    await teardown(h);
  });

  it("(b) non-terminal status (working) does NOT fire worker-done — only the done transition does", async () => {
    const h = buildHarness(new Date("2026-05-26T09:00:00.000Z"));
    const boot = await bootManager(h, repo.path, [{ kind: "worker-done" }]);

    await postHook(h, boot.managerSessionId, "Stop");
    h.spawns[0]!.writes.length = 0;

    const worker = await spawnWorker(h, boot.workspaceId, "issue-mid");
    await postStatus(h, worker, "working", "writing the failing test");
    await postStatus(h, worker, "blocked", "need a decision");

    const workerDone = h.dispatches
      .listForAgent(boot.managerAgentId)
      .filter((r) => r.trigger_kind === "worker-done");
    expect(workerDone.length).toBe(0);
    expect(lastInjectedContent(h.spawns[0]!)).toBe("");

    await teardown(h);
  });

  it("(c) N completions while manager BUSY → N native wakes (write-through, no coalescing)", async () => {
    // Write-through (#573, AC #4): each completion is injected immediately as an
    // independent wake rather than enqueued for coalesced flush-on-idle. N honest
    // wakes beat 1 lossy coalesced one once delivery is reliable. Stop fires a
    // flush but nothing is pending, so no additional injection.
    const h = buildHarness(new Date("2026-05-26T09:00:00.000Z"));
    const boot = await bootManager(h, repo.path, [{ kind: "worker-done" }]);
    // Manager stays busy (boot session registered busy by default).

    const w1 = await spawnWorker(h, boot.workspaceId, "issue-a");
    const w2 = await spawnWorker(h, boot.workspaceId, "issue-b");

    await postStatus(h, w1, "done", "shipped a");
    await postStatus(h, w2, "done", "shipped b");

    // Both done-signals are injected immediately — write-through, not enqueued.
    const injected = h.dispatches
      .listForAgent(boot.managerAgentId)
      .filter((r) => r.trigger_kind === "worker-done" && r.dispatch_outcome === "injected");
    expect(injected.length).toBe(2);

    // Each wake targets one worker; the last injection carries issue-b's info.
    const content = lastInjectedContent(h.spawns[0]!);
    expect(content).toContain("issue-b");
    expect(content).toContain("shipped b");

    // Stop flushes pending wakes (nothing pending → no additional injection).
    await postHook(h, boot.managerSessionId, "Stop");
    const allInjected = h.dispatches
      .listForAgent(boot.managerAgentId)
      .filter((r) => r.trigger_kind === "worker-done" && r.dispatch_outcome === "injected");
    expect(allInjected.length).toBe(2); // unchanged — Stop added nothing

    await teardown(h);
  });

  it("(d) coexistence: worker-done and session-ended fire independently on the same manager", async () => {
    const h = buildHarness(new Date("2026-05-26T09:00:00.000Z"));
    // Manager declares BOTH: worker-done for the happy-path done signal,
    // session-ended for crash/kill cleanup. The new kind does not supersede.
    const boot = await bootManager(h, repo.path, [
      { kind: "worker-done" },
      { kind: "session-ended" },
    ]);

    await postHook(h, boot.managerSessionId, "Stop");
    h.spawns[0]!.writes.length = 0;

    const worker = await spawnWorker(h, boot.workspaceId, "issue-coexist");
    // Happy path: worker declares done (PR opened, still alive) → worker-done
    // wakes the (idle) manager, which then becomes busy on the injection.
    await postStatus(h, worker, "done", "PR opened");
    // Manager finishes that turn and goes idle again.
    await postHook(h, boot.managerSessionId, "Stop");
    // Later the worker process actually terminates → session-ended fires too,
    // independently, on the now-idle manager. The new kind does not supersede it.
    await postHook(h, worker.sessionId, "SessionEnd");

    const audit = h.dispatches.listForAgent(boot.managerAgentId);
    const workerDone = audit.filter((r) => r.trigger_kind === "worker-done");
    const sessionEnded = audit.filter((r) => r.trigger_kind === "session-ended");
    expect(workerDone.length).toBe(1);
    expect(workerDone[0]!.dispatch_outcome).toBe("injected");
    expect(sessionEnded.length).toBe(1);
    expect(sessionEnded[0]!.dispatch_outcome).toBe("injected");

    await teardown(h);
  });
});
