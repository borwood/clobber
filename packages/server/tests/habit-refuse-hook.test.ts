import { DRIFT_STUB_API_BASE } from "./_drift-stub.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore } from "../src/event-store.ts";
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
import type { AgentSpawner, SpawnedAgentInfo } from "../src/types.ts";
import { HabitSchema, type Habit, type Session } from "@clobber/shared";

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  sessions: ReturnType<typeof createSessionStore>;
  tokens: ReturnType<typeof createSessionTokenStore>;
}

function buildHarness(resolveSessionHabits: (s: Session) => readonly Habit[]): Harness {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const tokens = createSessionTokenStore(db);
  const spawner: AgentSpawner = (req): SpawnedAgentInfo => {
    if (req.sessionId === undefined) throw new Error("expected sessionId");
    return {
      sessionId: req.sessionId,
      pid: 9999,
      exited: new Promise<number | null>(() => {}),
      stdin: makeStdin(),
      kill: () => {},
    };
  };
  const server = createServer({
    db,
    store: createEventStore(db),
    workspaces,
    roles,
    roleVersions,
    workspaceRoles,
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: tokens,
    agentStatuses: createAgentStatusStore(db),
    agentStatusLog: createAgentStatusLogStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner,
    hookUrl: "http://test.invalid/hook",
    apiBase: DRIFT_STUB_API_BASE,
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
    resolveSessionHabits,
  });
  return { server, db, workspaces, roles, workspaceRoles, sessions, tokens };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

interface BootedAgent {
  sessionId: string;
  agentId: string;
  workspaceId: string;
}

async function bootAgent(h: Harness, repoPath: string): Promise<BootedAgent> {
  const ws = h.workspaces.create({ name: "ws", repo_path: repoPath });
  const role = h.roles.create({ name: "worker", persistent: false });
  h.workspaceRoles.setCeiling(ws.id, role.id, 5);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: role.id, prompt: "boot", label: "boot" },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { session_id: string; agent_id: string };
  return { sessionId: body.session_id, agentId: body.agent_id, workspaceId: ws.id };
}

function habit(partial: Record<string, unknown>): Habit {
  return HabitSchema.parse(partial);
}

function preToolUsePayload(
  sessionId: string,
  cwd: string,
  toolName: string,
  toolInput: Record<string, unknown>,
) {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd,
    permission_mode: "bypassPermissions",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "toolu_test",
  } as const;
}

let repoPath: string;
let worktreePath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-refuse-repo-"));
  worktreePath = mkdtempSync(join(tmpdir(), "clobber-refuse-wt-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(worktreePath, { recursive: true, force: true });
});

// ── Inject (no regression) ────────────────────────────────────────────────────

describe("inject habit — no regression after refuse is added", () => {
  it("an inject habit still returns additionalContext on match", async () => {
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "hint",
        match: "Edit",
        action: { kind: "inject", hint: "use small edits" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUsePayload(boot.sessionId, repoPath, "Edit", {
        file_path: join(repoPath, "foo.ts"),
        old_string: "a",
        new_string: "b",
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.hookSpecificOutput).toBeDefined();
    const out = body.hookSpecificOutput as Record<string, unknown>;
    expect(out.permissionDecision).toBeUndefined();
    expect(out.additionalContext).toBe("use small edits");
    await teardown(h);
  });
});

// ── No-match / disabled → allow ───────────────────────────────────────────────

describe("no-match / disabled refuse habit → allow", () => {
  it("a refuse habit that does not match the tool name returns { continue: true }", async () => {
    const h = buildHarness((session) => [
      habit({
        path: "self.tool-use",
        name: "jail",
        match: "Edit|Write",
        action: { kind: "refuse", predicate: { outside: repoPath }, reason: "jailed" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUsePayload(boot.sessionId, worktreePath, "Bash", {
        command: "ls",
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });

  it("a disabled refuse habit does not fire", async () => {
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "jail",
        enabled: false,
        action: { kind: "refuse", predicate: { outside: repoPath }, reason: "jailed" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUsePayload(boot.sessionId, repoPath, "Edit", {
        file_path: join(repoPath, "foo.ts"),
        old_string: "a",
        new_string: "b",
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });
});

// ── Refuse → PreToolUse deny shape ────────────────────────────────────────────

describe("refuse habit → PreToolUse deny shape", () => {
  it("an Edit targeting the forbidden root returns the deny shape", async () => {
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "jail",
        action: { kind: "refuse", predicate: { outside: repoPath }, reason: "main checkout is off-limits" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUsePayload(boot.sessionId, worktreePath, "Edit", {
        file_path: join(repoPath, "packages", "server", "src", "foo.ts"),
        old_string: "a",
        new_string: "b",
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const out = body.hookSpecificOutput as Record<string, unknown>;
    expect(out).toBeDefined();
    expect(out.hookEventName).toBe("PreToolUse");
    expect(out.permissionDecision).toBe("deny");
    expect(typeof out.permissionDecisionReason).toBe("string");
    expect(out.permissionDecisionReason).toContain("main checkout is off-limits");
    await teardown(h);
  });

  it("a Write targeting the forbidden root returns the deny shape", async () => {
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "jail",
        action: { kind: "refuse", predicate: { outside: repoPath }, reason: "jailed" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUsePayload(boot.sessionId, worktreePath, "Write", {
        file_path: join(repoPath, "packages", "server", "src", "new-file.ts"),
        content: "export const x = 1;",
      }),
    });
    expect(res.statusCode).toBe(200);
    const out = (res.json() as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>;
    expect(out.permissionDecision).toBe("deny");
    await teardown(h);
  });
});

// ── Path-jail predicate edge cases ────────────────────────────────────────────

describe("path-jail predicate edges", () => {
  it("in-worktree allow: a write to the worktree (not under outside) is allowed", async () => {
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "jail",
        action: { kind: "refuse", predicate: { outside: repoPath }, reason: "jailed" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUsePayload(boot.sessionId, worktreePath, "Write", {
        file_path: join(worktreePath, "packages", "server", "src", "foo.ts"),
        content: "x",
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });

  it("desk-glob allow: a write to the desk dir (under except) is allowed even though outside=repoPath", async () => {
    const deskDir = join(repoPath, ".clobber", "agents", "test-agent", "desk");
    const h = buildHarness((session) => [
      habit({
        path: "self.tool-use",
        name: "jail",
        action: {
          kind: "refuse",
          predicate: { outside: repoPath, except: join(repoPath, ".clobber", "agents") },
          reason: "jailed",
        },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUsePayload(boot.sessionId, worktreePath, "Write", {
        file_path: join(deskDir, "notes.md"),
        content: "my notes",
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });

  it("under allow: a write to the `under` subzone within the forbidden root is allowed", async () => {
    const allowedSubdir = join(repoPath, "allowed-subdir");
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "jail",
        action: {
          kind: "refuse",
          predicate: { outside: repoPath, under: allowedSubdir },
          reason: "jailed",
        },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUsePayload(boot.sessionId, worktreePath, "Write", {
        file_path: join(allowedSubdir, "foo.ts"),
        content: "x",
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });

  it("Bash-write-into-main deny: a Bash redirect targeting repoPath is denied", async () => {
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "jail",
        action: { kind: "refuse", predicate: { outside: repoPath }, reason: "jailed" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUsePayload(boot.sessionId, worktreePath, "Bash", {
        command: `echo x > ${join(repoPath, "packages", "foo.ts")}`,
      }),
    });
    expect(res.statusCode).toBe(200);
    const out = (res.json() as Record<string, unknown>).hookSpecificOutput as Record<string, unknown>;
    expect(out.permissionDecision).toBe("deny");
    await teardown(h);
  });

  it("Bash without write intent is always allowed", async () => {
    const h = buildHarness(() => [
      habit({
        path: "self.tool-use",
        name: "jail",
        action: { kind: "refuse", predicate: { outside: repoPath }, reason: "jailed" },
      }),
    ]);
    const boot = await bootAgent(h, repoPath);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUsePayload(boot.sessionId, worktreePath, "Bash", {
        command: `cat ${join(repoPath, "README.md")}`,
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });
});
