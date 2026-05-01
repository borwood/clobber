import { describe, it, expect } from "bun:test";
import { createEventStore } from "../src/event-store.ts";
import type { HookPayload } from "@clobber/shared";

const baseEnvelope = {
  session_id: "9c4bedcd-627e-4dcd-a959-9be3d3a69e9a",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/tmp",
  permission_mode: "default",
} as const;

const sessionA = "11111111-1111-4111-8111-111111111111";
const sessionB = "22222222-2222-4222-8222-222222222222";

describe("event store", () => {
  it("appends a payload and returns it via list()", () => {
    const store = createEventStore(":memory:");
    const payload: HookPayload = {
      ...baseEnvelope,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "toolu_test_abc",
    };

    const stored = store.append(payload);
    expect(stored.id).toBeGreaterThan(0);
    expect(typeof stored.received_at).toBe("number");
    expect(stored.payload).toEqual(payload);

    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.payload).toEqual(payload);

    store.close();
  });

  it("preserves insertion order across appends", () => {
    const store = createEventStore(":memory:");
    const events: HookPayload[] = [
      { ...baseEnvelope, hook_event_name: "UserPromptSubmit", prompt: "hi" },
      {
        ...baseEnvelope,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo a" },
        tool_use_id: "toolu_a",
      },
      { ...baseEnvelope, hook_event_name: "Stop" },
    ];

    for (const e of events) store.append(e);

    const listed = store.list();
    expect(listed.map((r) => r.payload.hook_event_name)).toEqual([
      "UserPromptSubmit",
      "PreToolUse",
      "Stop",
    ]);

    store.close();
  });

  it("filters events by session_id", () => {
    const store = createEventStore(":memory:");
    store.append({ ...baseEnvelope, session_id: sessionA, hook_event_name: "Stop" });
    store.append({ ...baseEnvelope, session_id: sessionB, hook_event_name: "Stop" });
    store.append({ ...baseEnvelope, session_id: sessionA, hook_event_name: "SessionEnd" });

    const a = store.list({ session_id: sessionA });
    const b = store.list({ session_id: sessionB });

    expect(a.map((r) => r.payload.hook_event_name)).toEqual(["Stop", "SessionEnd"]);
    expect(b.map((r) => r.payload.hook_event_name)).toEqual(["Stop"]);

    store.close();
  });

  it("persists across reopens of the same file", () => {
    const path = `/tmp/clobber-store-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

    const first = createEventStore(path);
    first.append({ ...baseEnvelope, hook_event_name: "Stop" });
    first.close();

    const second = createEventStore(path);
    const events = second.list();
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.hook_event_name).toBe("Stop");
    second.close();
  });

  it("aggregates listSessions() with first/last seen + count + last event", async () => {
    const store = createEventStore(":memory:");

    store.append({ ...baseEnvelope, session_id: sessionA, hook_event_name: "UserPromptSubmit", prompt: "go" });
    await Bun.sleep(2);
    store.append({
      ...baseEnvelope,
      session_id: sessionA,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "toolu_a",
    });
    await Bun.sleep(2);
    store.append({ ...baseEnvelope, session_id: sessionB, hook_event_name: "Stop" });
    await Bun.sleep(2);
    store.append({ ...baseEnvelope, session_id: sessionA, hook_event_name: "Stop" });

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(2);

    const a = sessions.find((s) => s.session_id === sessionA)!;
    const b = sessions.find((s) => s.session_id === sessionB)!;

    expect(a.event_count).toBe(3);
    expect(a.last_event_name).toBe("Stop");
    expect(a.first_seen_at).toBeLessThanOrEqual(a.last_seen_at);

    expect(b.event_count).toBe(1);
    expect(b.last_event_name).toBe("Stop");

    expect(a.last_seen_at).toBeGreaterThan(b.last_seen_at);

    store.close();
  });

  it("orders listSessions() by most-recent activity first", () => {
    const store = createEventStore(":memory:");
    store.append({ ...baseEnvelope, session_id: sessionA, hook_event_name: "Stop" });
    store.append({ ...baseEnvelope, session_id: sessionB, hook_event_name: "Stop" });

    const sessions = store.listSessions();
    expect(sessions.map((s) => s.session_id)).toEqual([sessionB, sessionA]);

    store.close();
  });

  it("isolates events between distinct in-memory stores", () => {
    const a = createEventStore(":memory:");
    const b = createEventStore(":memory:");

    a.append({ ...baseEnvelope, hook_event_name: "Stop" });

    expect(a.list()).toHaveLength(1);
    expect(b.list()).toHaveLength(0);

    a.close();
    b.close();
  });
});
