import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeContextLength } from "@clobber/shared";
import { tailReadTranscript, TAIL_WINDOW_BYTES } from "../src/transcript-reader.ts";

// Direct tests of the real tailReadTranscript function. The integration tests
// in session-length-habit.test.ts inject a counting reader — these tests prove
// the production bounded-read code itself is correct.

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "clobber-tail-reader-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

describe("tailReadTranscript", () => {
  // Build a file > TAIL_WINDOW_BYTES. The early assistant turn is placed in the
  // first ~75 bytes; enough padding lines follow to push the tail boundary past
  // it; the late assistant turn is appended last.
  //
  // Assertions:
  //   1. Tail-only parse: only lines inside the tail window are returned —
  //      the early turn (outside the window) is absent.
  //   2. computeContextLength returns the late value, not the early one.
  //   3. No throw: the partial first line of the tail slice (sliced mid-JSON)
  //      is silently skipped, matching readTranscript's policy.
  it("skips the early turn outside the window, returns the late turn, tolerates partial first line", async () => {
    const EARLY_TOKENS = 11_111;
    const LATE_TOKENS = 99_999;

    const earlyLine =
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: EARLY_TOKENS } } }) +
      "\n";
    const paddingLine = JSON.stringify({ type: "system", content: "x".repeat(90) }) + "\n";
    const lateLine =
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: LATE_TOKENS } } }) +
      "\n";

    // Target total: TAIL_WINDOW_BYTES + 2048 so the tail boundary falls well
    // past the early line (which is only ~75 bytes into the file).
    const targetSize = TAIL_WINDOW_BYTES + 2048;
    const paddingCount = Math.ceil((targetSize - earlyLine.length - lateLine.length) / paddingLine.length) + 1;

    const parts: string[] = [earlyLine];
    for (let i = 0; i < paddingCount; i++) parts.push(paddingLine);
    parts.push(lateLine);

    const content = parts.join("");
    // Confirm the file is over the boundary (otherwise the test premise is wrong).
    expect(content.length).toBeGreaterThan(TAIL_WINDOW_BYTES);

    const path = join(tmpDir, "large.jsonl");
    writeFileSync(path, content);

    const lines = await tailReadTranscript(path);

    // Only the late assistant turn should be present.
    const assistantLines = lines.filter((l) => l["type"] === "assistant");
    expect(assistantLines).toHaveLength(1);
    expect(assistantLines[0]).toMatchObject({ message: { usage: { input_tokens: LATE_TOKENS } } });

    // computeContextLength returns the late value.
    expect(computeContextLength(lines)).toBe(LATE_TOKENS);
  });

  it("returns all lines when the file fits within TAIL_WINDOW_BYTES", async () => {
    const path = join(tmpDir, "small.jsonl");
    writeFileSync(
      path,
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 500 } } }) + "\n",
    );
    const lines = await tailReadTranscript(path);
    expect(lines).toHaveLength(1);
    expect(computeContextLength(lines)).toBe(500);
  });

  it("returns [] for a nonexistent file without throwing", async () => {
    const lines = await tailReadTranscript(join(tmpDir, "no-such-file.jsonl"));
    expect(lines).toEqual([]);
  });
});
