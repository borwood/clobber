import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectTranscriptPoison,
  repairTranscript,
  repairTranscriptFile,
} from "../src/session-health.ts";
import type { TranscriptLine } from "../src/transcript-reader.ts";

// IMPORTANT: claude redacts thinking *text* from the persisted JSONL and keeps
// only the signature, so `{thinking:"", signature}` is the NORMAL on-disk form
// of EVERY healthy thinking block (verified against the #360 forensics). These
// fixtures model that real form so the detector is exercised honestly — empty
// thinking content must never be treated as poison.
const userTurn = (text: string): TranscriptLine => ({
  type: "user",
  message: { role: "user", content: text },
});
const toolResultTurn = (toolId: string): TranscriptLine => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }],
  },
});
// A healthy turn that thinks (empty-content+signature, the real form) then calls
// a tool — completed by the matching tool_result that follows.
const thinkThenTool = (sig: string, toolId: string): TranscriptLine => ({
  type: "assistant",
  message: {
    model: "claude-opus-4-8",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: sig },
      { type: "tool_use", id: toolId, name: "Bash", input: { cmd: "ls" } },
    ],
  },
});
// A healthy turn that thinks then gives a terminal text answer.
const thinkThenText = (sig: string, text: string): TranscriptLine => ({
  type: "assistant",
  message: {
    model: "claude-opus-4-8",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: sig },
      { type: "text", text },
    ],
  },
});
// The interrupted turn: it ends on a thinking block (empty-content+signature,
// like every persisted thinking block) with no terminal continuation.
const interruptedThinking = (sig: string): TranscriptLine => ({
  type: "assistant",
  message: {
    model: "claude-opus-4-8",
    role: "assistant",
    content: [{ type: "thinking", thinking: "", signature: sig }],
  },
});
const syntheticError = (): TranscriptLine => ({
  type: "assistant",
  message: {
    model: "<synthetic>",
    role: "assistant",
    content: [{ type: "text", text: "API Error: 400 thinking blocks cannot be modified" }],
  },
});
const recoveryReprompt = (): TranscriptLine => ({
  type: "user",
  message: { role: "user", content: "Your previous turn stalled… Start now" },
});

// A long healthy session that used extended thinking on every turn — the case
// the previous (empty-thinking) detector would have catastrophically truncated.
function healthyLongFixture(): TranscriptLine[] {
  return [
    userTurn("start the task"),
    thinkThenTool("sigA==", "toolu_1"),
    toolResultTurn("toolu_1"),
    thinkThenTool("sigB==", "toolu_2"),
    toolResultTurn("toolu_2"),
    thinkThenText("sigC==", "All done."),
  ];
}

// The bricked tail: a healthy prefix, then an interrupted thinking turn, then
// the synthetic-error debris interleaved with clobber recovery re-prompts.
function poisonedFixture(): TranscriptLine[] {
  return [
    userTurn("hi"),
    thinkThenTool("sig1==", "toolu_9"),
    toolResultTurn("toolu_9"), // index 2 — last clean boundary
    interruptedThinking("sigBROKEN=="), // index 3 — incomplete trailing turn
    syntheticError(),
    recoveryReprompt(),
    syntheticError(),
  ];
}

describe("session-health — detectTranscriptPoison", () => {
  it("flags the synthetic tail and pulls in the one incomplete turn before it", () => {
    const diag = detectTranscriptPoison(poisonedFixture());
    expect(diag.poisoned).toBe(true);
    expect(diag.cutIndex).toBe(3);
  });

  it("does NOT flag a long healthy session built entirely from empty-thinking turns", () => {
    // Regression for the over-broad marker: every thinking block here is the
    // real `{thinking:"", signature}` form. None is poison.
    const diag = detectTranscriptPoison(healthyLongFixture());
    expect(diag.poisoned).toBe(false);
    expect(diag.cutIndex).toBe(-1);
  });

  it("strips only the synthetic debris when the preceding turn is a finished answer", () => {
    // A completed text turn that happens to precede synthetic debris is kept —
    // bias toward false-negatives, never cut a finished turn.
    const lines = [userTurn("q"), thinkThenText("sigT==", "the answer"), syntheticError()];
    const diag = detectTranscriptPoison(lines);
    expect(diag.poisoned).toBe(true);
    expect(diag.cutIndex).toBe(2);
  });

  it("pulls in an incomplete tool_use turn (unanswered) before the synthetic tail", () => {
    const lines = [userTurn("q"), thinkThenTool("sigU==", "toolu_x"), syntheticError()];
    expect(detectTranscriptPoison(lines).cutIndex).toBe(1);
  });

  it("does NOT flag a transient synthetic error the session recovered past", () => {
    // A transient API error (e.g. a 529 overload) writes a synthetic turn, then
    // the session recovers and continues with healthy, closed turns. That old
    // synthetic is mid-history, not the unrecoverable tail — repairing it would
    // silently delete all the recovered work.
    const lines = [
      userTurn("start"),
      thinkThenTool("sigA==", "toolu_1"),
      toolResultTurn("toolu_1"), // first exchange closed
      syntheticError(), // transient error...
      userTurn("retry"),
      thinkThenText("sigB==", "recovered and finished"), // ...session recovered past it
    ];
    const diag = detectTranscriptPoison(lines);
    expect(diag.poisoned).toBe(false);
    expect(diag.cutIndex).toBe(-1);
  });

  it("repairs nothing when there is no synthetic anchor (incomplete tail but no debris)", () => {
    // A session killed mid-thinking but not yet resumed has no synthetic debris.
    // Conservative: leave it alone rather than risk cutting healthy history.
    const lines = [userTurn("hi"), thinkThenTool("sigA==", "toolu_1"), interruptedThinking("sigB==")];
    const diag = detectTranscriptPoison(lines);
    expect(diag.poisoned).toBe(false);
    expect(diag.cutIndex).toBe(-1);
  });
});

describe("session-health — repairTranscript", () => {
  it("truncates the synthetic tail + incomplete turn back to the last clean boundary", () => {
    const { lines, dropped } = repairTranscript(poisonedFixture());
    expect(dropped).toBe(4);
    expect(lines.length).toBe(3);
    expect(lines[lines.length - 1]).toEqual(toolResultTurn("toolu_9"));
    expect(detectTranscriptPoison(lines).poisoned).toBe(false);
  });

  it("is a no-op on a long healthy empty-thinking session (dropped: 0, all preserved)", () => {
    const healthy = healthyLongFixture();
    const { lines, dropped } = repairTranscript(healthy);
    expect(dropped).toBe(0);
    expect(lines).toEqual(healthy);
  });
});

describe("session-health — repairTranscriptFile (on-disk JSONL)", () => {
  it("rewrites a poisoned transcript file to a resumable state, preserving kept bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-health-"));
    const path = join(dir, "poisoned.jsonl");
    const fixture = poisonedFixture();
    const rawLines = fixture.map((l) => JSON.stringify(l));
    writeFileSync(path, rawLines.join("\n") + "\n");

    const result = await repairTranscriptFile(path);
    expect(result.poisoned).toBe(true);
    expect(result.dropped).toBe(4);

    const after = readFileSync(path, "utf8");
    const keptRaw = after.split("\n").filter((l) => l.length > 0);
    expect(keptRaw.length).toBe(3);
    // Kept records are byte-identical to the originals (signatures intact).
    expect(keptRaw).toEqual(rawLines.slice(0, 3));
    expect(after).not.toContain("<synthetic>");

    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op on a healthy empty-thinking transcript file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-health-"));
    const path = join(dir, "healthy.jsonl");
    const original = healthyLongFixture().map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeFileSync(path, original);

    const result = await repairTranscriptFile(path);
    expect(result.poisoned).toBe(false);
    expect(result.dropped).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(original);

    rmSync(dir, { recursive: true, force: true });
  });
});
