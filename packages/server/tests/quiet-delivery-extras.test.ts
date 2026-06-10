import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { HabitSchema, type Habit, type HookPayload } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createNotificationStore } from "../src/notification-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createRoleVersionStore } from "../src/role-version-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createWorkspaceSessionSummaries } from "../src/workspace-session-summaries.ts";
import { createSessionTokenStore } from "../src/session-token-store.ts";
import { createAgentStatusStore } from "../src/agent-status-store.ts";
import { createAgentStatusLogStore } from "../src/agent-status-log-store.ts";
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { createFinalReportConsumerStateStore } from "../src/final-report-consumer.ts";
import { createAgentRegistry } from "../src/agent-registry.ts";
import { createServer } from "../src/server.ts";
import { createEventStore } from "../src/event-store.ts";
import { deliver, type DeliverDeps } from "../src/notification-dispatch.ts";
import { seedWorkspaceRoles } from "../src/seed-workspace-roles.ts";
import { claudeRuntimeProvider } from "@clobber/runtime";
import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { stubSpawnedAgent } from "./_spawner-stub.ts";

// ─── shared helpers ───────────────────────────────────────────────────────────

function habit(partial: Record<string, unknown>): Habit {
  return HabitSchema.parse(partial);
}

let repoPath: string;
let habits: readonly Habit[] = [];

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-qd-extras-"));
  habits = [];
});
afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

interface ComposerHarness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  sessionId: string;
  agentId: string;
}

function buildComposerHarness(): ComposerHarness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);

  const server = createServer({
    db,
    store: createEventStore(db),
    workspaces,
    roles,
    roleVersions: createRoleVersionStore(db),
    workspaceRoles: createWorkspaceRoleStore(db),
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner: () => stubSpawnedAgent({ pid: 9999 }),
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
    resolveSessionHabits: () => habits,
    habitRandom: () => 0,
    habitRunBash: () => "",
  });

  const ws = workspaces.create({ name: "ws", repo_path: repoPath });
  const role = roles.create({ name: `role-${randomUUID()}`, persistent: false });
  const agent = agents.create({ workspace_id: ws.id, role_id: role.id });
  const sessionId = randomUUID();
  sessions.create({ id: sessionId, agent_id: agent.id, workspace_id: ws.id, role_id: role.id, pid: 9000 });

  return { server, db, sessionId, agentId: agent.id };
}

function uprPayload(sessionId: string, prompt = "hello"): HookPayload {
  return {
    session_id: sessionId,
    hook_event_name: "UserPromptSubmit",
    prompt,
    transcript_path: "/tmp/t.jsonl",
    cwd: repoPath,
    permission_mode: "bypassPermissions",
  };
}

function ptuPayload(sessionId: string, filePath?: string): HookPayload {
  return {
    session_id: sessionId,
    hook_event_name: "PostToolUse",
    tool_name: filePath !== undefined ? "Write" : "Bash",
    tool_input: filePath !== undefined ? { file_path: filePath } : { command: "ls" },
    tool_use_id: "toolu_t",
    tool_response: filePath !== undefined ? { type: "create", filePath } : { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
    transcript_path: "/tmp/t.jsonl",
    cwd: repoPath,
    permission_mode: "bypassPermissions",
  };
}

function writeLines(name: string, lines: number): string {
  const abs = join(repoPath, name);
  writeFileSync(abs, Array.from({ length: lines }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n");
  return abs;
}

function insertQuietRow(db: ReturnType<typeof createDatabase>, agentId: string, body: string): void {
  db.prepare(
    `INSERT INTO notifications
       (id, type, recipient_kind, recipient_agent_id, priority,
        payload_json, provenance_json, metadata_json, state, created_at,
        delivered_at, acked_at, logical_key, delivery_mode)
     VALUES (?, 'alert', 'agent', ?, 'high', ?, '{"source_kind":"test"}', '{}',
             'pending', ?, NULL, NULL, NULL, 'quiet')`,
  ).run(randomUUID(), agentId, JSON.stringify({ body, tag: { kind: "trigger" } }), Date.now());
}

// ─── AC2 — byte-goldens ───────────────────────────────────────────────────────

describe("AC2 — composer byte-golden: single-producer cases unchanged", () => {
  it("habit-only on UserPromptSubmit: response byte-identical to pre-composer evaluateSelfHabits output", async () => {
    const h = buildComposerHarness();
    const HINT = "always write tests first";
    habits = [habit({ path: "self.session-message", name: "tdd", action: { kind: "inject", hint: HINT } })];

    const res = await h.server.inject({ method: "POST", url: "/hook", payload: uprPayload(h.sessionId) });
    expect(res.statusCode).toBe(200);
    // Byte-identical to pre-composer: exactly this shape, no double-wrapping, no extra keys.
    const body = res.json() as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(body).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: HINT },
    });
    await h.server.close();
    h.db.close();
  });

  it("file-size-reminder-only on PostToolUse: response byte-identical to pre-composer buildFileSizeReminder output", async () => {
    const h = buildComposerHarness();
    const bigFile = writeLines("big.ts", 400);

    const res = await h.server.inject({ method: "POST", url: "/hook", payload: ptuPayload(h.sessionId, bigFile) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { hookSpecificOutput?: { hookEventName: string; additionalContext: string } };
    expect(body.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    // Exact reminder text — byte-identical to what buildFileSizeReminder returns directly.
    expect(body.hookSpecificOutput?.additionalContext).toBe(
      "`big.ts` is now 400 lines, over the 300-line ceiling — consider splitting it by responsibility.",
    );
    await h.server.close();
    h.db.close();
  });

  it("AC2 co-fire: file-size reminder + habit hint on same PostToolUse → ONE wrapper, both texts present", async () => {
    const h = buildComposerHarness();
    const HINT = "split this file";
    habits = [habit({ path: "self.tool-use", name: "split", match: "Write", phase: "post", action: { kind: "inject", hint: HINT } })];
    const bigFile = writeLines("cofire.ts", 400);

    const res = await h.server.inject({ method: "POST", url: "/hook", payload: ptuPayload(h.sessionId, bigFile) });
    const body = res.json() as { hookSpecificOutput?: { hookEventName: string; additionalContext: string } };
    // One wrapper only
    expect(body.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    // Both producers present in the composed output
    expect(body.hookSpecificOutput?.additionalContext).toContain("cofire.ts");
    expect(body.hookSpecificOutput?.additionalContext).toContain(HINT);
    // Reminder first, then habit (producer order)
    const ctx = body.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx.indexOf("cofire.ts")).toBeLessThan(ctx.indexOf(HINT));
    await h.server.close();
    h.db.close();
  });
});

// ─── AC3 — compose-N ─────────────────────────────────────────────────────────

describe("AC3 — compose-N: habit hint + quiet notification → one wrapper, both texts", () => {
  it("habit + quiet item on UserPromptSubmit → ONE hookSpecificOutput, both texts present", async () => {
    const h = buildComposerHarness();
    const HINT = "check the tests";
    const QUIET_BODY = "you have a pending task";
    habits = [habit({ path: "self.session-message", name: "h", action: { kind: "inject", hint: HINT } })];
    insertQuietRow(h.db, h.agentId, QUIET_BODY);

    const res = await h.server.inject({ method: "POST", url: "/hook", payload: uprPayload(h.sessionId) });
    const body = res.json() as { hookSpecificOutput?: { hookEventName: string; additionalContext: string } };

    // Exactly one wrapper
    expect(body.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
    // Both producers present
    expect(body.hookSpecificOutput?.additionalContext).toContain(HINT);
    expect(body.hookSpecificOutput?.additionalContext).toContain(QUIET_BODY);
    // Joined with "\n\n" — habit first, quiet drain second
    expect(body.hookSpecificOutput?.additionalContext).toBe(`${HINT}\n\n${QUIET_BODY}`);
    await h.server.close();
    h.db.close();
  });
});

// ─── AC5 — interrupt path golden ─────────────────────────────────────────────

describe("AC5 — interrupt path golden: non-quiet deliver() is byte-unchanged", () => {
  it("null delivery_mode notification with live session → stdin bytes written (inject behaviour unchanged)", async () => {
    const db = createDatabase(":memory:");
    const workspaces = createWorkspaceStore(db);
    const roles = createRoleStore(db);
    const agents = createAgentStore(db);
    const sessions = createSessionStore(db);
    const registry = createAgentRegistry();
    const store = createNotificationStore(db);

    seedWorkspaceRoles(db, workspaces.create({ name: "ws", repo_path: "/tmp/r" }).id);
    const ws = db.prepare("SELECT id FROM workspaces WHERE name = 'ws'").get() as { id: string };
    const roleRow = db.prepare("SELECT id FROM roles WHERE name = 'manager' AND workspace_id = ?").get(ws.id) as { id: string };
    const agent = agents.create({ workspace_id: ws.id, role_id: roleRow.id });

    const sessionId = "live-1";
    const stdin = new PassThrough();
    stdin.resume();
    const writes: Buffer[] = [];
    stdin.on("data", (c: Buffer) => writes.push(c));
    sessions.create({ id: sessionId, agent_id: agent.id, workspace_id: ws.id, role_id: roleRow.id, pid: 5001 });
    registry.register(sessionId, stdin, () => {}, false);

    const now = Date.now();
    // Non-quiet notification (delivery_mode null — interrupt behaviour)
    const { notification } = store.create({
      type: "trigger",
      category: "transient",
      recipient: { kind: "agent", agent_id: agent.id },
      priority: "high",
      payload: { body: "you have work to do", tag: { kind: "trigger" } },
      provenance: { source_kind: "test" },
    }, now);

    const deps: DeliverDeps = {
      agents,
      roles,
      workspaces,
      sessions,
      registry,
      runtimeProvider: claudeRuntimeProvider,
      attachSession: async () => { throw new Error("should not spawn"); },
      resumeEndedSession: async () => { throw new Error("should not resume"); },
    };

    const outcome = await deliver(deps, notification, { kind: "drop" });
    // Interrupt path: injected into live session
    expect(outcome.action).toBe("injected");
    // Stdin received the bytes (write-through)
    expect(writes.length).toBeGreaterThan(0);
    const text = Buffer.concat(writes).toString("utf8");
    expect(text).toContain("you have work to do");

    db.close();
  });
});

// ─── AC7 — hot-path bound ─────────────────────────────────────────────────────

describe("AC7 — hot-path: zero-pending quiet drain = no work beyond the SELECT", () => {
  it("drainQuietForAgent with no pending quiet rows returns [] immediately", () => {
    const db = createDatabase(":memory:");
    const store = createNotificationStore(db);
    const agentId = "agent-x";

    // No rows at all → SELECT returns empty → no UPDATE, no JSON.parse
    const result = store.drainQuietForAgent(agentId, Date.now());
    expect(result).toHaveLength(0);
    expect(result).toEqual([]);
    db.close();
  });

  it("drainQuietForAgent skips non-quiet pending rows (interrupt rows stay pending)", () => {
    const db = createDatabase(":memory:");
    const workspaces = createWorkspaceStore(db);
    const roles = createRoleStore(db);
    const agents = createAgentStore(db);
    const store = createNotificationStore(db);

    const ws = workspaces.create({ name: "ws", repo_path: "/tmp/r2" });
    const role = roles.create({ name: "r", persistent: false });
    const agent = agents.create({ workspace_id: ws.id, role_id: role.id });

    // Insert an interrupt-mode (null delivery_mode) notification
    store.create({
      type: "trigger",
      category: "transient",
      recipient: { kind: "agent", agent_id: agent.id },
      priority: "high",
      payload: { body: "interrupt me", tag: { kind: "trigger" } },
      provenance: { source_kind: "test" },
    }, Date.now());

    // Drain returns nothing (only quiet rows are drained)
    const drained = store.drainQuietForAgent(agent.id, Date.now());
    expect(drained).toHaveLength(0);

    // The interrupt row is still pending
    expect(store.listPending()).toHaveLength(1);
    db.close();
  });
});
