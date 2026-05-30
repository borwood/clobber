import type { TranscriptLine } from "./transcript-reader.ts";

/**
 * Transcript-integrity primitive for the #360 thinking-block poison-pill.
 *
 * When an assistant turn carrying an extended-thinking block is interrupted
 * before it completes (a `clobber kill`, a stall, or a mid-turn stdin inject),
 * the claude CLI cannot continue it and stamps `model:"<synthetic>"` error
 * placeholders into the JSONL while the resume loop keeps re-hitting the API's
 * "thinking blocks in the latest assistant message cannot be modified" 400.
 * The dangling partial turn plus that synthetic debris sit at the tail and
 * brick every subsequent resume — alive but unable to advance.
 *
 * `detect` → `repair`: find that unrecoverable trailing region and truncate it
 * back to the last clean boundary, so resume/inject re-send a valid history.
 *
 * The signal is the trailing run of `model:"<synthetic>"` placeholders (they
 * appear only in the debris, never in healthy history) plus the single
 * incomplete real-assistant turn immediately preceding it. It is emphatically
 * NOT empty thinking content: claude redacts thinking *text* from the persisted
 * transcript and keeps only the signature, so `{thinking:"", signature}` is the
 * NORMAL on-disk form of every healthy thinking block. Treating it as poison
 * would truncate nearly any transcript that ever used extended thinking — a
 * silent, catastrophic false positive. Repair is therefore biased hard toward
 * false-negatives: with no synthetic anchor, repair nothing (a missed poison
 * just falls back to the status quo / fresh-spawn; a wrongful cut is data loss).
 *
 * `detectTranscriptPoison` is exposed standalone as the detector the #325
 * spawn-health supervisor consumes without re-deriving it.
 */
export interface PoisonDiagnosis {
  // True when the transcript ends in the unrecoverable synthetic-debris region.
  readonly poisoned: boolean;
  // Index of the first record to drop (keep records `[0, cutIndex)`). -1 when
  // the transcript is clean.
  readonly cutIndex: number;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function messageOf(line: TranscriptLine): Record<string, unknown> | null {
  return asObject(line["message"]);
}

// A CLI error placeholder. The runtime stamps `model:"<synthetic>"` on records
// it writes when a continuation fails — the marker of the unrecoverable tail.
function isSyntheticErrorRecord(line: TranscriptLine): boolean {
  const message = messageOf(line);
  return message !== null && message["model"] === "<synthetic>";
}

// The type of a real assistant turn's last content block, or null for anything
// that is not a real (non-synthetic) assistant message. Empty thinking content
// is the normal persisted form and carries no signal — only block STRUCTURE does.
function lastBlockType(line: TranscriptLine): string | null {
  const message = messageOf(line);
  if (
    message === null ||
    message["role"] !== "assistant" ||
    message["model"] === "<synthetic>"
  ) {
    return null;
  }
  const content = message["content"];
  if (!Array.isArray(content) || content.length === 0) return null;
  const last = asObject(content[content.length - 1]);
  if (last === null) return null;
  const type = last["type"];
  return typeof type === "string" ? type : null;
}

// A user turn carrying a `tool_result` — the record that closes the tool_use of
// the assistant turn before it.
function isToolResultTurn(line: TranscriptLine): boolean {
  const message = messageOf(line);
  if (message === null || message["role"] !== "user") return false;
  const content = message["content"];
  if (!Array.isArray(content)) return false;
  return content.some((block) => asObject(block)?.["type"] === "tool_result");
}

/**
 * Locate the unrecoverable trailing region. Only a STRICTLY-TRAILING broken
 * region is poison: walking back from the tail, a finished assistant turn (ends
 * in `text`) or a `tool_result` that closes a tool_use turn is a clean boundary
 * — the session was healthy there, so everything at and before it stays.
 *
 * The trailing region swept up is the `model:"<synthetic>"` debris plus the
 * recovery re-prompts / bookkeeping records interleaved with it, optionally
 * fronted by the single incomplete assistant turn that started the break (ends
 * on `thinking`/`tool_use`, unanswered). The region is poison only if it
 * actually contains synthetic debris — so a transient synthetic the session
 * later recovered past (a closed turn exists after it) is NOT flagged, and an
 * incomplete tail with no debris is left alone. Both biases are toward
 * false-negatives: a wrongful cut silently deletes healthy history.
 */
export function detectTranscriptPoison(
  lines: readonly TranscriptLine[],
): PoisonDiagnosis {
  let cut = lines.length;
  let sawSynthetic = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (isSyntheticErrorRecord(line)) {
      sawSynthetic = true;
      cut = i;
      continue;
    }
    const type = lastBlockType(line);
    if (type === "text") break; // a finished answer — clean boundary
    if (type === "thinking" || type === "redacted_thinking" || type === "tool_use") {
      // The incomplete turn that started the break: include it, then stop —
      // never walk back past the one originating turn into healthy history.
      cut = i;
      break;
    }
    if (isToolResultTurn(line)) break; // closes a tool_use turn — clean boundary
    // A recovery re-prompt or non-message bookkeeping record in the debris.
    cut = i;
  }
  if (!sawSynthetic) return { poisoned: false, cutIndex: -1 };
  return { poisoned: true, cutIndex: cut };
}

/**
 * Truncate the unrecoverable trailing region back to the last clean boundary.
 * Returns the repaired record list and how many trailing records were dropped.
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
