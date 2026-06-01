import { describe, it, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeRuntimeProvider } from "@clobber/runtime";
import type { RoleTrigger } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createAgentRegistry } from "../src/agent-registry.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import { createNotificationDispatcher } from "../src/notification-dispatch.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { createTestClock } from "../src/clock.ts";
import { defaultSynthesizePrompt } from "../src/trigger-synthesize.ts";
import {
  dispatchTrigger,
  type AgentBinding,
  type BusyPolicy,
  type DispatchDeps,
} from "../src/trigger-dispatch.ts";
import type { AttachSessionFn, AttachOutcome } from "../src/trigger-attach.ts";

const TRIGGER: RoleTrigger = { kind: "cron", expr: "0 9 * * *" };
const SYNTH = "a cron fired: 0 9 * * *";

interface Harness {
  db: ReturnType<typeof createDatabase>;
  deps: DispatchDeps;
  binding: AgentBinding;
  agentId: string;
  sessions: ReturnType<typeof createSessionStore>;
  registry: ReturnType<typeof createAgentRegistry>;
  dispatches: ReturnType<typeof createTriggerDispatchStore>;
  notifications: ReturnType<typeof createNotificationStore>;
  spawnCalls: Parameters<AttachSessionFn>[0][];
}

function makeHarness(opts: { attach?: AttachSessionFn } = {}): Harness {
  const db = createDatabase(":memory:");
  const clock = createTestClock(new Date("2026-06-01T09:00:00.000Z"));
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const registry = createAgentRegistry();
  const dispatches = createTriggerDispatchStore(db);
  const notifications = createNotificationStore(db);
  const dispatcher = createNotificationDispatcher(notifications, clock);

  const repoPath = mkdtempSync(join(tmpdir(), "clobber-notif-dispatch-"));
  writeFileSync(join(repoPath, ".git"), "gitdir: stub\n");
  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  seedWorkspaceRoles(db, ws.id);
  const roleRow = db
    .prepare("SELECT id FROM roles WHERE name = ? AND workspace_id = ?")
    .get("manager", ws.id) as { id: string };
  const agent = agents.create({ workspace_id: ws.id, role_id: roleRow.id, label: "mgr-1" });

  const spawnCalls: Parameters<AttachSessionFn>[0][] = [];
  const defaultAttach: AttachSessionFn = async (input) => {
    spawnCalls.push(input);
    // Mirror attachSessionToAgent: a real attach persists the session row before
    // returning, so the trigger-dispatch audit's session_id FK resolves.
    sessions.create({
      id: "spawned-session-1",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: roleRow.id,
      pid: 4242,
    });
    const ok: AttachOutcome = {
      ok: true,
      agent_id: agent.id,
      session_id: "spawned-session-1",
      pid: 4242,
    };
    return ok;
  };
  const attachSession: AttachSessionFn = async (input) => {
    spawnCalls.push(input);
    return opts.attach === undefined ? defaultAttach(input) : opts.attach(input);
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
    attachSession: opts.attach === undefined ? defaultAttach : attachSession,
    synthesize: defaultSynthesizePrompt,
    dispatcher,
  };

  return {
    db,
    deps,
    binding: { agentId: agent.id, roleId: roleRow.id, workspaceId: ws.id },
    agentId: agent.id,
    sessions,
    registry,
    dispatches,
    notifications,
    spawnCalls: opts.attach === undefined ? spawnCalls : spawnCalls,
  };
}

function liveSession(h: Harness, id: string, busy: boolean): PassThrough {
  const stdin = new PassThrough();
  stdin.resume();
  h.sessions.create({
    id,
    agent_id: h.agentId,
    workspace_id: h.binding.workspaceId,
    role_id: h.binding.roleId,
    pid: 5000,
  });
  h.registry.register(id, stdin, () => {}, busy);
  return stdin;
}

describe("notification dispatch — recipient-state router (golden invariant)", () => {
  it("idle (no session) → spawned: audit + a delivered notification record", async () => {
    const h = makeHarness();
    const landed = await dispatchTrigger(h.deps, h.binding, TRIGGER, undefined);
    expect(landed).toBe(true);

    const audit = h.dispatches.listForAgent(h.agentId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.dispatch_outcome).toBe("spawned");
    expect(audit[0]!.session_id).toBe("spawned-session-1");
    expect(audit[0]!.trigger_kind).toBe("cron");

    const notifs = h.notifications.listForAgent(h.agentId);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.type).toBe("trigger");
    expect(notifs[0]!.state).toBe("delivered");
    expect(notifs[0]!.recipient).toEqual({ kind: "agent", agent_id: h.agentId });
    expect(notifs[0]!.payload).toEqual({
      body: SYNTH,
      tag: { kind: "trigger", attrs: { via: "cron" } },
    });
    expect(notifs[0]!.provenance.source_kind).toBe("trigger");
    h.db.close();
  });

  it("alive + idle → injected: stdin bytes + audit + delivered record all unchanged", async () => {
    const h = makeHarness();
    const writes: Buffer[] = [];
    const stdin = liveSession(h, "live-idle-1", true);
    stdin.on("data", (c: Buffer) => writes.push(c));
    h.registry.setBusy("live-idle-1", false);

    await dispatchTrigger(h.deps, h.binding, TRIGGER, undefined);

    const audit = h.dispatches.listForAgent(h.agentId);
    expect(audit[0]!.dispatch_outcome).toBe("injected");
    expect(audit[0]!.session_id).toBe("live-idle-1");

    const text = Buffer.concat(writes).toString("utf8");
    expect(text).toBe(
      claudeRuntimeProvider.serializeUserPrompt(SYNTH, {
        kind: "trigger",
        attrs: { via: "cron" },
      }),
    );

    const notifs = h.notifications.listForAgent(h.agentId);
    expect(notifs[0]!.state).toBe("delivered");
    h.db.close();
  });

  it("alive + busy, drop policy → skipped-busy: no session_id, notification stays pending", async () => {
    const h = makeHarness();
    liveSession(h, "live-busy-1", true);

    await dispatchTrigger(h.deps, h.binding, TRIGGER, undefined);

    const audit = h.dispatches.listForAgent(h.agentId);
    expect(audit[0]!.dispatch_outcome).toBe("skipped-busy");
    expect(audit[0]!.session_id).toBeUndefined();

    const notifs = h.notifications.listForAgent(h.agentId);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.state).toBe("pending");
    expect(notifs[0]!.delivered_at).toBeUndefined();
    h.db.close();
  });

  it("alive + busy, enqueue policy → queued: session_id + the enqueue callback fires", async () => {
    const h = makeHarness();
    liveSession(h, "live-busy-2", true);
    const enqueued: Array<{ agentId: string; trigger: RoleTrigger; payload: unknown }> = [];
    const busyPolicy: BusyPolicy = {
      kind: "enqueue",
      enqueue: (binding, trigger, payload) =>
        enqueued.push({ agentId: binding.agentId, trigger, payload }),
    };

    await dispatchTrigger(h.deps, h.binding, TRIGGER, { tick: 1 }, busyPolicy);

    const audit = h.dispatches.listForAgent(h.agentId);
    expect(audit[0]!.dispatch_outcome).toBe("queued");
    expect(audit[0]!.session_id).toBe("live-busy-2");

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.agentId).toBe(h.agentId);
    expect(enqueued[0]!.trigger).toEqual(TRIGGER);
    expect(enqueued[0]!.payload).toEqual({ tick: 1 });

    const notifs = h.notifications.listForAgent(h.agentId);
    expect(notifs[0]!.state).toBe("pending");
    h.db.close();
  });

  it("spawn failure → errored: error string preserved, notification stays pending", async () => {
    const h = makeHarness({
      attach: async () => ({
        ok: false,
        status: 422,
        error: "role has no current version",
        role: "manager",
      }),
    });

    await dispatchTrigger(h.deps, h.binding, TRIGGER, undefined);

    const audit = h.dispatches.listForAgent(h.agentId);
    expect(audit[0]!.dispatch_outcome).toBe("errored");
    expect(audit[0]!.error).toBe("role has no current version");
    expect(audit[0]!.session_id).toBeUndefined();

    const notifs = h.notifications.listForAgent(h.agentId);
    expect(notifs[0]!.state).toBe("pending");
    h.db.close();
  });

  it("returns false with no audit and no notification when the agent is gone", async () => {
    const h = makeHarness();
    const landed = await dispatchTrigger(
      h.deps,
      { agentId: "ghost", roleId: h.binding.roleId, workspaceId: h.binding.workspaceId },
      TRIGGER,
      undefined,
    );
    expect(landed).toBe(false);
    expect(h.dispatches.listForWorkspace(h.binding.workspaceId)).toHaveLength(0);
    h.db.close();
  });
});
