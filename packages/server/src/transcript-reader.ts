export type { TranscriptLine } from "@clobber/shared";
import type { TranscriptLine } from "@clobber/shared";

export async function readTranscript(path: string): Promise<TranscriptLine[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.text();
  const lines: TranscriptLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length === 0) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        lines.push(parsed as TranscriptLine);
      }
    } catch {
      // Skip malformed lines; transcripts can be partially flushed.
    }
  }
  return lines;
}

// Tail window for session-length bounded reads. 256 KiB covers ~60-80
// assistant turns at high verbosity, keeping per-hook I/O bounded even
// for very long sessions. The last assistant usage block is overwhelmingly
// within this window; the constant is exported so tests can assert it.
export const TAIL_WINDOW_BYTES = 256 * 1024;

// Reads only the last TAIL_WINDOW_BYTES of the transcript rather than the
// whole file. On large transcripts (200k-token sessions = several MB of
// JSONL) this keeps the hot PostToolUse/UserPromptSubmit path cheap. The
// first parsed line of a tail slice may be partial — JSON.parse throws and
// the line is silently skipped, matching readTranscript's existing policy.
export async function tailReadTranscript(path: string): Promise<TranscriptLine[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const size = file.size;
  const text =
    size <= TAIL_WINDOW_BYTES
      ? await file.text()
      : await file.slice(size - TAIL_WINDOW_BYTES).text();
  const lines: TranscriptLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length === 0) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        lines.push(parsed as TranscriptLine);
      }
    } catch {
      // Skip partial/malformed lines (first line of a tail slice may be partial).
    }
  }
  return lines;
}
