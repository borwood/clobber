import type { TranscriptLine } from "./transcript-reader.ts";

/**
 * Transcript-integrity primitive for the #360 thinking-block poison-pill.
 *
 * When an assistant turn carrying an extended-thinking block is interrupted
 * before it completes (a `clobber kill`, a stall, or a mid-turn stdin inject),
 * the claude CLI persists the partial assistant message with the thinking
 * block's content emptied (`thinking:""`) but its cryptographic `signature`
 * retained. Re-sending that trailing turn on the next resume/inject fails the
 * API's "thinking blocks in the latest assistant message cannot be modified"
 * check (400), and because the poison is persisted, every subsequent turn
 * re-hits it — a permanent brick.
 *
 * `detect` → `classify` → `repair`: scan a claude JSONL transcript for the
 * incomplete trailing region (poisoned thinking turns and/or trailing
 * `model:"<synthetic>"` CLI error placeholders) and truncate it back to the
 * last clean user/assistant boundary, so resume/inject de-poison before
 * re-sending history. This both prevents future bricks and recovers
 * already-bricked sessions.
 *
 * `detectTranscriptPoison` is exposed standalone as the detector the #325
 * spawn-health supervisor consumes without re-deriving it.
 */
export interface PoisonDiagnosis {
  // True when the transcript ends in an incomplete/poisoned region.
  readonly poisoned: boolean;
  // Index of the first record of the broken trailing region — the cut point
  // (keep records `[0, cutIndex)`). -1 when the transcript is clean.
  readonly cutIndex: number;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

// A thinking (or redacted_thinking) block whose content was emptied on an
// interrupt but whose signature survived — the core poison marker.
function hasPoisonedThinkingBlock(line: TranscriptLine): boolean {
  const message = asObject(line["message"]);
  if (message === null || message["role"] !== "assistant") return false;
  const content = message["content"];
  if (!Array.isArray(content)) return false;
  for (const raw of content) {
    const block = asObject(raw);
    if (block === null) continue;
    const type = block["type"];
    if (type !== "thinking" && type !== "redacted_thinking") continue;
    const body = type === "thinking" ? block["thinking"] : block["data"];
    const signature = block["signature"];
    if (body === "" && typeof signature === "string" && signature.length > 0) {
      return true;
    }
  }
  return false;
}

// A CLI error placeholder turn (`model:"<synthetic>"`) — the debris the runtime
// writes around the poison while the resume loop keeps re-hitting the 400.
function isSyntheticErrorRecord(line: TranscriptLine): boolean {
  const message = asObject(line["message"]);
  return message !== null && message["model"] === "<synthetic>";
}

function isBrokenRecord(line: TranscriptLine): boolean {
  return hasPoisonedThinkingBlock(line) || isSyntheticErrorRecord(line);
}

/**
 * Locate the incomplete trailing region. The poison bricks the session on first
 * occurrence — no legitimate turn survives after it — so the earliest broken
 * record is the start of the unrecoverable tail and the cut point. Everything
 * before it is, by construction, a clean resumable boundary.
 */
export function detectTranscriptPoison(
  lines: readonly TranscriptLine[],
): PoisonDiagnosis {
  for (let i = 0; i < lines.length; i++) {
    if (isBrokenRecord(lines[i]!)) return { poisoned: true, cutIndex: i };
  }
  return { poisoned: false, cutIndex: -1 };
}

/**
 * Truncate the dangling partial turn back to the last clean boundary. Returns
 * the repaired record list and how many trailing records were dropped.
 */
export function repairTranscript(lines: readonly TranscriptLine[]): {
  lines: TranscriptLine[];
  dropped: number;
} {
  const { poisoned, cutIndex } = detectTranscriptPoison(lines);
  if (!poisoned) return { lines: [...lines], dropped: 0 };
  return { lines: lines.slice(0, cutIndex), dropped: lines.length - cutIndex };
}

/**
 * Repair a transcript JSONL file in place. Reads the raw lines so kept records
 * are rewritten byte-for-byte (signatures stay intact — the latest surviving
 * assistant turn must re-send exactly as the API originally signed it), parses
 * each to classify, and rewrites only when poison is found.
 */
export async function repairTranscriptFile(
  path: string,
): Promise<{ poisoned: boolean; dropped: number }> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { poisoned: false, dropped: 0 };
  const text = await file.text();
  const rawLines = text.split("\n").filter((raw) => raw.length > 0);
  const parsed: TranscriptLine[] = rawLines.map((raw) => {
    try {
      const value = JSON.parse(raw) as unknown;
      const obj = asObject(value);
      return obj === null ? {} : obj;
    } catch {
      // A malformed line is opaque, not poison — keep it as-is.
      return {};
    }
  });
  const { poisoned, cutIndex } = detectTranscriptPoison(parsed);
  if (!poisoned) return { poisoned: false, dropped: 0 };
  const kept = rawLines.slice(0, cutIndex);
  await Bun.write(path, kept.length === 0 ? "" : kept.join("\n") + "\n");
  return { poisoned: true, dropped: rawLines.length - cutIndex };
}
