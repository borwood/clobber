import { describe, it, expect } from "bun:test";
import {
  deriveWorkingState,
  formatElapsed,
  formatTokens,
} from "../src/working-state.ts";
import type { TranscriptLine } from "../src/api.ts";

function lines(...l: object[]): TranscriptLine[] {
  return l as TranscriptLine[];
}

const userPrompt = (text = "do the thing", timestamp?: string) => ({
  type: "user",
  ...(timestamp === undefined ? {} : { timestamp }),
  message: { role: "user", content: text },
});

const toolResultTurn = () => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
  },
});

const assistantTool = (name: string, output_tokens = 0) => ({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name, input: {} }],
    usage: { output_tokens },
  },
});

const assistantText = (text: string, output_tokens = 0) => ({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { output_tokens },
  },
});

const thinkingPulse = () => ({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "thinking", thinking: "", signature: "x" }],
  },
});

describe("deriveWorkingState: verb from most-recent message type", () => {
  it("maps a trailing Bash tool_use to 'Running'", () => {
    expect(deriveWorkingState(lines(userPrompt(), assistantTool("Bash"))).verb).toBe("Running");
  });

  it("maps Read → Reading, Edit → Editing, Grep → Searching, Task → Delegating", () => {
    expect(deriveWorkingState(lines(userPrompt(), assistantTool("Read"))).verb).toBe("Reading");
    expect(deriveWorkingState(lines(userPrompt(), assistantTool("Edit"))).verb).toBe("Editing");
    expect(deriveWorkingState(lines(userPrompt(), assistantTool("Grep"))).verb).toBe("Searching");
    expect(deriveWorkingState(lines(userPrompt(), assistantTool("Task"))).verb).toBe("Delegating");
  });

  it("falls back to 'Clobbering' for an unknown tool", () => {
    expect(deriveWorkingState(lines(userPrompt(), assistantTool("Frobnicate"))).verb).toBe("Clobbering");
  });

  it("maps trailing assistant text to 'Writing'", () => {
    expect(deriveWorkingState(lines(userPrompt(), assistantText("hello"))).verb).toBe("Writing");
  });

  it("maps a trailing thinking pulse to 'Thinking'", () => {
    expect(deriveWorkingState(lines(userPrompt(), thinkingPulse())).verb).toBe("Thinking");
  });

  it("maps a trailing tool_result (agent processing output) to 'Thinking'", () => {
    expect(deriveWorkingState(lines(userPrompt(), assistantTool("Bash"), toolResultTurn())).verb).toBe("Thinking");
  });

  it("uses the LAST tool_use when an assistant line has several", () => {
    const multi = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "Read", input: {} },
          { type: "tool_use", id: "b", name: "Bash", input: {} },
        ],
        usage: { output_tokens: 0 },
      },
    };
    expect(deriveWorkingState(lines(userPrompt(), multi)).verb).toBe("Running");
  });

  it("defaults to 'Clobbering' with only a user prompt or no lines", () => {
    expect(deriveWorkingState(lines(userPrompt())).verb).toBe("Clobbering");
    expect(deriveWorkingState(lines()).verb).toBe("Clobbering");
  });
});

describe("deriveWorkingState: turn start", () => {
  it("takes the timestamp of the most recent user prompt", () => {
    const ts = "2026-05-23T12:00:00Z";
    const s = deriveWorkingState(lines(userPrompt("first"), assistantText("a"), userPrompt("second", ts)));
    expect(s.startMs).toBe(new Date(ts).getTime());
  });

  it("ignores tool_result user lines when locating turn start", () => {
    const ts = "2026-05-23T12:00:00Z";
    const s = deriveWorkingState(lines(userPrompt("p", ts), assistantTool("Bash"), toolResultTurn()));
    expect(s.startMs).toBe(new Date(ts).getTime());
  });

  it("is null when the prompt has no timestamp", () => {
    expect(deriveWorkingState(lines(userPrompt())).startMs).toBeNull();
  });
});

describe("deriveWorkingState: output tokens this turn", () => {
  it("sums output_tokens of assistant lines after the last user prompt", () => {
    const s = deriveWorkingState(
      lines(userPrompt(), assistantTool("Bash", 100), assistantText("done", 50)),
    );
    expect(s.outputTokens).toBe(150);
  });

  it("resets across turns — only counts the current turn", () => {
    const s = deriveWorkingState(
      lines(
        userPrompt("first"),
        assistantText("a", 999),
        userPrompt("second"),
        assistantText("b", 100),
      ),
    );
    expect(s.outputTokens).toBe(100);
  });
});

describe("formatElapsed", () => {
  it("renders seconds under a minute", () => {
    expect(formatElapsed(5)).toBe("5s");
  });
  it("renders minutes and seconds", () => {
    expect(formatElapsed(102)).toBe("1m 42s");
  });
  it("renders hours and minutes past an hour", () => {
    expect(formatElapsed(3661)).toBe("1h 1m");
  });
});

describe("formatTokens", () => {
  it("renders raw counts under 1k", () => {
    expect(formatTokens(999)).toBe("999");
  });
  it("renders thousands with one decimal, trimming a trailing .0", () => {
    expect(formatTokens(2200)).toBe("2.2k");
    expect(formatTokens(2000)).toBe("2k");
  });
});
