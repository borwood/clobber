import { describe, expect, it } from "bun:test";
import {
  normalizeCodexExecEvent,
  parseCodexExecJsonl,
} from "../src/codex-jsonl.ts";

describe("Codex exec JSONL normalization (#100)", () => {
  it("normalizes a first-turn stdout stream into runtime events", () => {
    const text = [
      `{"type":"thread.started","thread_id":"019e0b86-a368-7702-9bf3-f5dce89dc9e9"}`,
      `{"type":"turn.started"}`,
      `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}`,
      `{"type":"turn.completed","usage":{"input_tokens":13452,"cached_input_tokens":12160,"output_tokens":5,"reasoning_output_tokens":0}}`,
    ].join("\n");

    expect(parseCodexExecJsonl(text)).toEqual([
      {
        kind: "provider-thread-started",
        providerThreadId: "019e0b86-a368-7702-9bf3-f5dce89dc9e9",
      },
      { kind: "turn-started" },
      { kind: "assistant-message", itemId: "item_0", text: "ok" },
      {
        kind: "turn-completed",
        usage: {
          inputTokens: 13452,
          cachedInputTokens: 12160,
          outputTokens: 5,
          reasoningOutputTokens: 0,
        },
      },
    ]);
  });

  it("normalizes a resume stream using the same provider thread id", () => {
    const events = parseCodexExecJsonl([
      `{"type":"thread.started","thread_id":"019e0b86-a368-7702-9bf3-f5dce89dc9e9"}`,
      `{"type":"turn.started"}`,
      `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"resumed"}}`,
      `{"type":"turn.completed","usage":{"input_tokens":27153,"cached_input_tokens":25344,"output_tokens":11,"reasoning_output_tokens":0}}`,
    ].join("\n"));

    expect(events[0]).toEqual({
      kind: "provider-thread-started",
      providerThreadId: "019e0b86-a368-7702-9bf3-f5dce89dc9e9",
    });
    expect(events[2]).toEqual({
      kind: "assistant-message",
      itemId: "item_0",
      text: "resumed",
    });
  });

  it("normalizes tool-shaped completed items without assuming a specific tool", () => {
    expect(normalizeCodexExecEvent({
      type: "item.completed",
      item: {
        id: "call_1",
        type: "function_call",
        name: "exec_command",
        arguments: { cmd: "pwd" },
      },
    })).toEqual([
      {
        kind: "tool-call",
        itemId: "call_1",
        name: "exec_command",
        input: { cmd: "pwd" },
      },
    ]);

    expect(normalizeCodexExecEvent({
      type: "item.completed",
      item: {
        id: "call_1",
        type: "function_call_output",
        output: "ok",
      },
    })).toEqual([
      {
        kind: "tool-result",
        itemId: "call_1",
        output: "ok",
      },
    ]);
  });

  it("keeps unknown and malformed events visible to callers", () => {
    expect(parseCodexExecJsonl(`{"type":"future.event","x":1}\nnot-json`)).toEqual([
      {
        kind: "unknown",
        eventType: "future.event",
        payload: { type: "future.event", x: 1 },
      },
      { kind: "unknown", eventType: "malformed-json", payload: "not-json" },
    ]);
  });
});
