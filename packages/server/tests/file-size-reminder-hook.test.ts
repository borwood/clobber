import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import type { FileSizePolicy, HookPayload } from "@clobber/shared";

interface Harness {
  server: ReturnType<typeof createServer>;
  db: ReturnType<typeof createDatabase>;
  workspaces: ReturnType<typeof createWorkspaceStore>;
  roles: ReturnType<typeof createRoleStore>;
  workspaceRoles: ReturnType<typeof createWorkspaceRoleStore>;
  sessions: ReturnType<typeof createSessionStore>;
  tokens: ReturnType<typeof createSessionTokenStore>;
}

function makeStdin(): NodeJS.WritableStream {
  const s = new PassThrough();
  s.resume();
  return s;
}

function buildHarness(): Harness {
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
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
    dispatches: createTriggerDispatchStore(db),
    finalReportConsumerState: createFinalReportConsumerStateStore(db),
  });
  return { server, db, workspaces, roles, workspaceRoles, sessions, tokens };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  h.db.close();
}

interface BootedAgent {
  workspaceId: string;
  agentId: string;
  sessionId: string;
}

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-filesize-hook-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

async function bootAgent(
  h: Harness,
  filePolicy?: FileSizePolicy,
): Promise<BootedAgent> {
  const ws = h.workspaces.create({
    name: "ws",
    repo_path: repoPath,
    ...(filePolicy === undefined ? {} : { file_size_policy: filePolicy }),
  });
  const role = h.roles.create({ name: "worker", persistent: false });
  h.workspaceRoles.setCeiling(ws.id, role.id, 5);
  const res = await h.server.inject({
    method: "POST",
    url: "/spawn",
    payload: { workspace_id: ws.id, role_id: role.id, prompt: "boot", label: "boot" },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { session_id: string; agent_id: string };
  return { workspaceId: ws.id, agentId: body.agent_id, sessionId: body.session_id };
}

// Write a file of `lines` lines into the workspace repo and return its absolute
// path, ready to feed as an Edit/Write tool_input.file_path.
function writeFile(name: string, lines: number): string {
  const abs = join(repoPath, name);
  const content = Array.from({ length: lines }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n";
  writeFileSync(abs, content);
  return abs;
}

function writeHook(sessionId: string, filePath: string): HookPayload {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd: repoPath,
    permission_mode: "bypassPermissions",
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: filePath, content: "..." },
    tool_use_id: `toolu_${Math.random().toString(36).slice(2, 10)}`,
    tool_response: { type: "create", filePath },
  };
}

function editHook(sessionId: string, filePath: string): HookPayload {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd: repoPath,
    permission_mode: "bypassPermissions",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: "a", new_string: "b" },
    tool_use_id: `toolu_${Math.random().toString(36).slice(2, 10)}`,
    tool_response: { filePath },
  };
}

interface HookReply {
  continue?: boolean;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext: string;
  };
}

async function hook(h: Harness, payload: HookPayload): Promise<{ status: number; body: HookReply }> {
  const res = await h.server.inject({ method: "POST", url: "/hook", payload });
  return { status: res.statusCode, body: res.json() as HookReply };
}

describe("PostToolUse(Edit/Write) → file-size reminder (#193)", () => {
  it("editing a code file over the default 300-line ceiling emits an advisory reminder", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);
    const file = writeFile("big.ts", 392);

    const { status, body } = await hook(h, editHook(boot.sessionId, file));
    expect(status).toBe(200);
    expect(body.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    expect(body.hookSpecificOutput?.additionalContext).toContain("big.ts");
    expect(body.hookSpecificOutput?.additionalContext).toContain("392");
    expect(body.hookSpecificOutput?.additionalContext).toContain("300");
    // Advisory only — the hook never carries a block/deny decision.
    expect(JSON.stringify(body)).not.toContain("deny");

    await teardown(h);
  });

  it("a code file under the ceiling emits nothing", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);
    const file = writeFile("small.ts", 120);

    const { status, body } = await hook(h, writeHook(boot.sessionId, file));
    expect(status).toBe(200);
    expect(body.hookSpecificOutput).toBeUndefined();

    await teardown(h);
  });

  it("a non-code file over the ceiling emits nothing (markdown/fixtures are legitimately large)", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);
    const mdFile = writeFile("README.md", 500);
    const testFile = writeFile("thing.test.ts", 500);

    const md = await hook(h, writeHook(boot.sessionId, mdFile));
    expect(md.body.hookSpecificOutput).toBeUndefined();

    const test = await hook(h, writeHook(boot.sessionId, testFile));
    expect(test.body.hookSpecificOutput).toBeUndefined();

    await teardown(h);
  });

  it("a custom max_lines threshold is honored", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h, { kind: "on", max_lines: 100 });
    const file = writeFile("mid.ts", 150);

    const { body } = await hook(h, writeHook(boot.sessionId, file));
    expect(body.hookSpecificOutput?.additionalContext).toContain("100");
    expect(body.hookSpecificOutput?.additionalContext).toContain("150");

    await teardown(h);
  });

  it("policy off disables the reminder entirely", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h, { kind: "off" });
    const file = writeFile("big.ts", 400);

    const { body } = await hook(h, writeHook(boot.sessionId, file));
    expect(body.hookSpecificOutput).toBeUndefined();

    await teardown(h);
  });

  it("a non-Edit/Write PostToolUse never triggers the reminder", async () => {
    const h = buildHarness();
    const boot = await bootAgent(h);
    writeFile("big.ts", 400);

    const bashHook: HookPayload = {
      session_id: boot.sessionId,
      transcript_path: "/tmp/t.jsonl",
      cwd: repoPath,
      permission_mode: "bypassPermissions",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "wc -l big.ts" },
      tool_use_id: "toolu_bash",
      tool_response: { stdout: "400", stderr: "", interrupted: false },
    };
    const { body } = await hook(h, bashHook);
    expect(body.hookSpecificOutput).toBeUndefined();

    await teardown(h);
  });
});
