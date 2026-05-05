import { describe, it, expect } from "bun:test";
import { createServer } from "../src/server.ts";
import { createDatabase } from "../src/db.ts";
import { createEventStore, type StoredEvent } from "../src/event-store.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createRoleVersionStore } from "../src/role-version-store.ts";
import { createWorkspaceRoleStore } from "../src/workspace-role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createWorkspaceSessionSummaries } from "../src/workspace-session-summaries.ts";
import { createSessionTokenStore } from "../src/session-token-store.ts";
import { createAgentStatusStore } from "../src/agent-status-store.ts";
import { createAgentQuestionStore } from "../src/agent-question-store.ts";
import { createAgentQuestionWaiter } from "../src/agent-question-waiter.ts";
import { createTriggerDispatchStore } from "../src/trigger-dispatch-store.ts";
import { stubSpawnedAgent } from "./_spawner-stub.ts";
import type { HookPayload } from "@clobber/shared";

const baseEnvelope = {
  session_id: "9c4bedcd-627e-4dcd-a959-9be3d3a69e9a",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/tmp",
  permission_mode: "default",
} as const;

const sessionA = "11111111-1111-4111-8111-111111111111";
const sessionB = "22222222-2222-4222-8222-222222222222";

function buildServer() {
  const db = createDatabase(":memory:");
  const store = createEventStore(db);
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
const roleVersions = createRoleVersionStore(db);
  const workspaceRoles = createWorkspaceRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const server = createServer({
    db,
    store,
    workspaces,
    roles,

    roleVersions,
    workspaceRoles,
    agents,
    sessions,
    sessionSummaries: createWorkspaceSessionSummaries(db),
    sessionTokens: createSessionTokenStore(db),
    agentStatuses: createAgentStatusStore(db),
    agentQuestions: createAgentQuestionStore(db),
    agentQuestionWaiter: createAgentQuestionWaiter(),
    spawner: () => stubSpawnedAgent(),
    hookUrl: "http://test.invalid/hook",
    apiBase: "http://test.invalid",
    cliEntry: "/dummy/cli.ts",
  
    dispatches: createTriggerDispatchStore(db),
  });
  return { server, db };
}

describe("hook receiver", () => {
  it("captures a valid PreToolUse and exposes it via /events", async () => {
    const { server, db } = buildServer();
    const sample: HookPayload = {
      ...baseEnvelope,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "toolu_test_abc",
    };

    const post = await server.inject({ method: "POST", url: "/hook", payload: sample });
    expect(post.statusCode).toBe(200);
    expect(post.json() as unknown).toEqual({ continue: true });

    const get = await server.inject({ method: "GET", url: "/events" });
    expect(get.statusCode).toBe(200);
    const events = get.json() as StoredEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual(sample);
    expect(events[0]!.id).toBeGreaterThan(0);
    expect(typeof events[0]!.received_at).toBe("number");

    await server.close();
    db.close();
  });

  it("preserves event order across multiple posts", async () => {
    const { server, db } = buildServer();
    const events: HookPayload[] = [
      { ...baseEnvelope, hook_event_name: "UserPromptSubmit", prompt: "hi" },
      {
        ...baseEnvelope,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo a" },
        tool_use_id: "toolu_a",
      },
      {
        ...baseEnvelope,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo a" },
        tool_use_id: "toolu_a",
        tool_response: {
          stdout: "a",
          stderr: "",
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
        },
      },
      { ...baseEnvelope, hook_event_name: "Stop" },
    ];

    for (const e of events) {
      await server.inject({ method: "POST", url: "/hook", payload: e });
    }

    const res = await server.inject({ method: "GET", url: "/events" });
    const captured = res.json() as StoredEvent[];
    expect(captured.map((e) => e.payload.hook_event_name)).toEqual([
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Stop",
    ]);

    await server.close();
    db.close();
  });

  it("rejects an invalid hook payload with 400 and does not store it", async () => {
    const { server, db } = buildServer();

    const post = await server.inject({
      method: "POST",
      url: "/hook",
      payload: { hook_event_name: "NotARealEvent", session_id: "bad" },
    });

    expect(post.statusCode).toBe(400);
    const body = post.json() as { error: string; issues: unknown };
    expect(body.error).toBe("invalid hook payload");
    expect(Array.isArray(body.issues)).toBe(true);

    const events = (await server.inject({ method: "GET", url: "/events" })).json() as unknown[];
    expect(events).toHaveLength(0);

    await server.close();
    db.close();
  });

  it("filters /events by session_id query param", async () => {
    const { server, db } = buildServer();

    await server.inject({
      method: "POST",
      url: "/hook",
      payload: { ...baseEnvelope, session_id: sessionA, hook_event_name: "Stop" },
    });
    await server.inject({
      method: "POST",
      url: "/hook",
      payload: { ...baseEnvelope, session_id: sessionB, hook_event_name: "Stop" },
    });
    await server.inject({
      method: "POST",
      url: "/hook",
      payload: { ...baseEnvelope, session_id: sessionA, hook_event_name: "SessionEnd" },
    });

    const a = (await server.inject({
      method: "GET",
      url: `/events?session_id=${sessionA}`,
    })).json() as StoredEvent[];
    const b = (await server.inject({
      method: "GET",
      url: `/events?session_id=${sessionB}`,
    })).json() as StoredEvent[];

    expect(a.map((e) => e.payload.hook_event_name)).toEqual(["Stop", "SessionEnd"]);
    expect(b.map((e) => e.payload.hook_event_name)).toEqual(["Stop"]);

    await server.close();
    db.close();
  });

  it("isolates events between server instances backed by separate stores", async () => {
    const a = buildServer();
    const b = buildServer();

    await a.server.inject({
      method: "POST",
      url: "/hook",
      payload: { ...baseEnvelope, hook_event_name: "Stop" },
    });

    const aEvents = (await a.server.inject({ method: "GET", url: "/events" })).json() as unknown[];
    const bEvents = (await b.server.inject({ method: "GET", url: "/events" })).json() as unknown[];

    expect(aEvents).toHaveLength(1);
    expect(bEvents).toHaveLength(0);

    await a.server.close();
    await b.server.close();
    a.db.close();
    b.db.close();
  });
});
