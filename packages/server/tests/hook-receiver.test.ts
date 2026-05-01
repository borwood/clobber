import { describe, it, expect } from "bun:test";
import { createServer } from "../src/server.ts";

describe("hook receiver", () => {
  it("captures a posted hook event and exposes it via /events", async () => {
    const server = createServer();

    const sample = {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: "/tmp",
      permission_mode: "default",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    };

    const post = await server.inject({ method: "POST", url: "/hook", payload: sample });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toEqual({ continue: true });

    const get = await server.inject({ method: "GET", url: "/events" });
    expect(get.statusCode).toBe(200);
    const events = get.json() as Array<typeof sample>;
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(sample);

    await server.close();
  });

  it("preserves event order across multiple posts", async () => {
    const server = createServer();
    const seq = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];

    for (const hook_event_name of seq) {
      await server.inject({
        method: "POST",
        url: "/hook",
        payload: { hook_event_name, session_id: "abc" },
      });
    }

    const res = await server.inject({ method: "GET", url: "/events" });
    const captured = res.json() as Array<{ hook_event_name: string }>;
    expect(captured.map((e) => e.hook_event_name)).toEqual(seq);

    await server.close();
  });

  it("isolates events between server instances", async () => {
    const a = createServer();
    const b = createServer();

    await a.inject({ method: "POST", url: "/hook", payload: { hook_event_name: "A" } });

    const aEvents = (await a.inject({ method: "GET", url: "/events" })).json() as unknown[];
    const bEvents = (await b.inject({ method: "GET", url: "/events" })).json() as unknown[];

    expect(aEvents).toHaveLength(1);
    expect(bEvents).toHaveLength(0);

    await a.close();
    await b.close();
  });
});
