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

// Records shaped per the #360 forensic (context.md): a poisoned trailing
// assistant turn carries a thinking block whose content was emptied but whose
// cryptographic signature was retained, optionally followed by CLI
// `model:"<synthetic>"` error placeholders and a clobber recovery re-prompt.
const userTurn = (text: string): TranscriptLine => ({
  type: "user",
  message: { role: "user", content: text },
});
const cleanAssistant = (): TranscriptLine => ({
  type: "assistant",
  message: {
    model: "claude-opus-4-8",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "weighing the options", signature: "sigCLEAN==" },
      { type: "text", text: "Here is the answer." },
    ],
  },
});
const poisonAssistant = (): TranscriptLine => ({
  type: "assistant",
  message: {
    model: "claude-opus-4-8",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "EsUKCmMIDhgCKkCk==" },
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { cmd: "ls" } },
    ],
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

function poisonedFixture(): TranscriptLine[] {
  return [
    userTurn("hi"),
    cleanAssistant(),
    userTurn("do X"), // index 2 — last clean boundary
    poisonAssistant(), // index 3 — first bad record
    syntheticError(),
    recoveryReprompt(),
    syntheticError(),
  ];
}

describe("session-health — detectTranscriptPoison", () => {
  it("flags the poisoned trailing region and points cutIndex at the first bad record", () => {
    const diag = detectTranscriptPoison(poisonedFixture());
    expect(diag.poisoned).toBe(true);
    expect(diag.cutIndex).toBe(3);
  });

  it("reports a clean transcript as not poisoned (cutIndex -1)", () => {
    const clean = [userTurn("hi"), cleanAssistant(), userTurn("again"), cleanAssistant()];
    const diag = detectTranscriptPoison(clean);
    expect(diag.poisoned).toBe(false);
    expect(diag.cutIndex).toBe(-1);
  });

  it("does NOT flag an emptied thinking block that has no signature (not the poison pattern)", () => {
    const unsigned: TranscriptLine[] = [
      userTurn("hi"),
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          role: "assistant",
          content: [{ type: "thinking", thinking: "", signature: "" }],
        },
      },
    ];
    expect(detectTranscriptPoison(unsigned).poisoned).toBe(false);
  });
});

describe("session-health — repairTranscript", () => {
  it("truncates the dangling partial turn back to the last clean user/assistant boundary", () => {
    const { lines, dropped } = repairTranscript(poisonedFixture());
    expect(dropped).toBe(4);
    expect(lines.length).toBe(3);
    // Last surviving record is the genuine user turn — a resumable boundary.
    expect(lines[lines.length - 1]).toEqual(userTurn("do X"));
    // No poison survives.
    expect(detectTranscriptPoison(lines).poisoned).toBe(false);
  });

  it("leaves a clean transcript untouched", () => {
    const clean = [userTurn("hi"), cleanAssistant()];
    const { lines, dropped } = repairTranscript(clean);
    expect(dropped).toBe(0);
    expect(lines).toEqual(clean);
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

    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op on a clean transcript file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clobber-health-"));
    const path = join(dir, "clean.jsonl");
    const fixture = [userTurn("hi"), cleanAssistant()];
    const original = fixture.map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeFileSync(path, original);

    const result = await repairTranscriptFile(path);
    expect(result.poisoned).toBe(false);
    expect(result.dropped).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(original);

    rmSync(dir, { recursive: true, force: true });
  });
});
