import { describe, it, expect } from "bun:test";
import { createServer } from "../src/server.ts";
import type { HookPayload } from "@clobber/shared";

const baseEnvelope = {
  session_id: "9c4bedcd-627e-4dcd-a959-9be3d3a69e9a",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/tmp",
  permission_mode: "default",
} as const;

describe("hook receiver", () => {
  it("captures a valid PreToolUse and exposes it via /events", async () => {
    const server = createServer();
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
    const events = get.json() as HookPayload[];
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(sample);

    await server.close();
  });

  it("preserves event order across multiple posts", async () => {
    const server = createServer();
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
    const captured = res.json() as HookPayload[];
    expect(captured.map((e) => e.hook_event_name)).toEqual([
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Stop",
    ]);

    await server.close();
  });

  it("rejects an invalid hook payload with 400 and does not store it", async () => {
    const server = createServer();

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
  });

  it("isolates events between server instances", async () => {
    const a = createServer();
    const b = createServer();

    await a.inject({
      method: "POST",
      url: "/hook",
      payload: { ...baseEnvelope, hook_event_name: "Stop" },
    });

    const aEvents = (await a.inject({ method: "GET", url: "/events" })).json() as unknown[];
    const bEvents = (await b.inject({ method: "GET", url: "/events" })).json() as unknown[];

    expect(aEvents).toHaveLength(1);
    expect(bEvents).toHaveLength(0);

    await a.close();
    await b.close();
  });
});
