import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { wrapClobberTag } from "@clobber/shared";

/**
 * Append a synthetic notification line to a session's transcript JSONL file.
 * Wraps a `<task-notification>` block in `<clobber type="interrupt-notice">`
 * so the receiving agent and the web transcript can both recognize it as
 * clobber-synthesized (subsumes the legacy `[SYSTEM NOTIFICATION - NOT USER
 * INPUT]` string-header).
 *
 * Safety: a single full-line `appendFileSync` opens with `a` (O_APPEND) and
 * issues one `write()` syscall — atomic against claude's concurrent appends
 * on Linux for sub-PIPE_BUF byte counts. Our line is well under that.
 *
 * The parent directory is ensured because the transcript path is now derived
 * at spawn (see #65) and may exist on the agent row before claude has
 * written anything to disk.
 */
export function appendTranscriptNotification(
  path: string,
  status: string,
  summary: string,
): void {
  const inner = [
    "<task-notification>",
    `<status>${status}</status>`,
    `<summary>${summary}</summary>`,
    "</task-notification>",
  ].join("\n");
  const content = wrapClobberTag(inner, { kind: "interrupt-notice" });
  const line = JSON.stringify({
    type: "user",
    message: { role: "user", content },
  });
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line + "\n");
}
