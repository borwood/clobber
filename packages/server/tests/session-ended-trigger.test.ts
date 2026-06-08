import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { makeRepoFixture, type RepoFixture } from "./repo-fixture.ts";
import {
  buildHarness,
  teardown,
  bootManager,
  spawnWorker,
  postHook,
  lastInjectedContent,
} from "./_completion-wake-harness.ts";

let repo: RepoFixture;
beforeEach(() => {
  repo = makeRepoFixture("clobber-session-ended-");
});
afterEach(() => {
  repo.cleanup();
});

describe("session-ended trigger — worker→manager completion signal", () => {
  it("(a) worker ends WITH a final-report → idle manager woken with rich payload (summary)", async () => {
    const h = buildHarness(new Date("2026-05-24T09:00:00.000Z"));
    const boot = await bootManager(h, repo.path, [{ kind: "session-ended" }]);

    // Manager goes idle so the wake injects rather than enqueues.
    await postHook(h, boot.managerSessionId, "Stop");
    h.spawns[0]!.writes.length = 0;

    const worker = await spawnWorker(h, boot.workspaceId, "issue-42");
    const reportRes = await h.server.inject({
      method: "POST",
      url: "/agent/report",
      headers: { authorization: `Bearer ${worker.token}` },
      payload: { free_text: "shipped PR #999" },
    });
    expect(reportRes.statusCode).toBe(200);

    await postHook(h, worker.sessionId, "SessionEnd");

    const audit = h.dispatches.listForAgent(boot.managerAgentId);
    const sessionEnded = audit.filter((r) => r.trigger_kind === "session-ended");
    expect(sessionEnded.length).toBe(1);
    expect(sessionEnded[0]!.dispatch_outcome).toBe("injected");

    const content = lastInjectedContent(h.spawns[0]!);
    expect(content).toContain("issue-42");
    expect(content).toContain("finished");
    expect(content).toContain("shipped PR #999");

    await teardown(h);
  });

  it("(b) worker ends WITHOUT a report (crash/kill) → idle manager woken with bare triage payload", async () => {
    const h = buildHarness(new Date("2026-05-24T09:00:00.000Z"));
    const boot = await bootManager(h, repo.path, [{ kind: "session-ended" }]);

    await postHook(h, boot.managerSessionId, "Stop");
    h.spawns[0]!.writes.length = 0;

    const worker = await spawnWorker(h, boot.workspaceId, "issue-77");
    // No /agent/report — simulate crash/kill end.
    await postHook(h, worker.sessionId, "SessionEnd");

    const audit = h.dispatches.listForAgent(boot.managerAgentId);
    const sessionEnded = audit.filter((r) => r.trigger_kind === "session-ended");
    expect(sessionEnded.length).toBe(1);
    expect(sessionEnded[0]!.dispatch_outcome).toBe("injected");

    const content = lastInjectedContent(h.spawns[0]!);
    expect(content).toContain("issue-77");
    expect(content).toContain("no report");
    expect(content).toContain("triage");

    await teardown(h);
  });

  it("(c) N completions while manager BUSY → N native wakes (write-through, no coalescing)", async () => {
    // Write-through (#573, AC #4): each completion is injected immediately as an
    // independent wake rather than enqueued for coalesced flush-on-idle. Stop fires
    // a flush but nothing is pending, so no additional injection.
    const h = buildHarness(new Date("2026-05-24T09:00:00.000Z"));
    const boot = await bootManager(h, repo.path, [{ kind: "session-ended" }]);
    // Manager stays busy (boot session registered busy by default).

    const w1 = await spawnWorker(h, boot.workspaceId, "issue-1");
    const w2 = await spawnWorker(h, boot.workspaceId, "issue-2");

    await postHook(h, w1.sessionId, "SessionEnd");
    await postHook(h, w2.sessionId, "SessionEnd");

    // Both completions are injected immediately — write-through, not enqueued.
    const injected = h.dispatches
      .listForAgent(boot.managerAgentId)
      .filter((r) => r.trigger_kind === "session-ended" && r.dispatch_outcome === "injected");
    expect(injected.length).toBe(2);

    // Each wake targets one worker; the last injection carries issue-2's info.
    const content = lastInjectedContent(h.spawns[0]!);
    expect(content).toContain("issue-2");

    // Stop flushes pending wakes (nothing pending → no additional injection).
    await postHook(h, boot.managerSessionId, "Stop");
    const allInjected = h.dispatches
      .listForAgent(boot.managerAgentId)
      .filter((r) => r.trigger_kind === "session-ended" && r.dispatch_outcome === "injected");
    expect(allInjected.length).toBe(2); // unchanged — Stop added nothing

    await teardown(h);
  });

  it("(d) spawn-pipeline child-exit (crash, non-zero) also wakes the manager", async () => {
    const h = buildHarness(new Date("2026-05-24T09:00:00.000Z"));
    const boot = await bootManager(h, repo.path, [{ kind: "session-ended" }]);

    await postHook(h, boot.managerSessionId, "Stop");
    h.spawns[0]!.writes.length = 0;

    const worker = await spawnWorker(h, boot.workspaceId, "issue-crash");
    const workerSpawn = h.spawns.find((s) => s.sessionId === worker.sessionId)!;

    // Child process dies with a non-zero code, no SessionEnd hook ever arrives.
    workerSpawn.resolveExit(1);
    await new Promise((r) => setTimeout(r, 10));

    const sessionEnded = h.dispatches
      .listForAgent(boot.managerAgentId)
      .filter((r) => r.trigger_kind === "session-ended");
    expect(sessionEnded.length).toBe(1);
    expect(sessionEnded[0]!.dispatch_outcome).toBe("injected");

    const content = lastInjectedContent(h.spawns[0]!);
    expect(content).toContain("issue-crash");
    expect(content).toContain("no report");

    await teardown(h);
  });
});
