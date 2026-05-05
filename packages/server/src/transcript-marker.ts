import { appendFileSync } from "node:fs";

/**
 * Append a synthetic notification line to a session's transcript JSONL file.
 * Mirrors the shape claude itself uses for `<task-notification>` events so
 * the web viewer's classifier renders it as a `NotificationCard`.
 *
 * Safety: a single full-line `appendFileSync` opens with `a` (O_APPEND) and
 * issues one `write()` syscall — atomic against claude's concurrent appends
 * on Linux for sub-PIPE_BUF byte counts. Our line is well under that.
 */
export function appendTranscriptNotification(
  path: string,
  status: string,
  summary: string,
): void {
  const content = [
    "[SYSTEM NOTIFICATION - NOT USER INPUT]",
    "This is an automated event, not a message from the user.",
    "",
    "<task-notification>",
    `<status>${status}</status>`,
    `<summary>${summary}</summary>`,
    "</task-notification>",
  ].join("\n");
  const line = JSON.stringify({
    type: "user",
    message: { role: "user", content },
  });
  appendFileSync(path, line + "\n");
}
