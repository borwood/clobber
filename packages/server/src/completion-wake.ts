// The payload a completion-wake trigger (`session-ended`, `worker-done`)
// carries into a persistent role's wake, and how it renders into the
// synthesized prompt. Built by a completion-wake scheduler from persistent
// state (the finished session's row + the row that signalled completion) and
// coalesced across multiple completions when the target was busy. See #171, #240.

export interface CompletionWakeItem {
  readonly sessionId: string;
  readonly label: string | null;
  // The finished session's completion summary (a worker's done-status summary
  // or its final-report summary), or null when the session ended without one
  // (crash / kill) — which the manager triages.
  readonly summary: string | null;
  // #620: status/report log row id used as a per-completion discriminator for
  // the logical_key. Present when a log row exists; absent for crash/kill where
  // no status row was written. Absent → falls back to session-only key (old
  // behavior) which is still correct for session-ended (ends exactly once).
  readonly completionId?: number;
}

export interface CompletionWakePayload {
  readonly ended: readonly CompletionWakeItem[];
}

function nameOf(item: CompletionWakeItem): string {
  return item.label === null ? item.sessionId : item.label;
}

function renderOne(item: CompletionWakeItem): string {
  const name = nameOf(item);
  return item.summary === null
    ? `worker '${name}' ended with no report — possible crash/kill, triage`
    : `worker '${name}' finished: ${item.summary}`;
}

function renderLine(item: CompletionWakeItem): string {
  const name = nameOf(item);
  return item.summary === null
    ? `- '${name}': ended with no report (triage)`
    : `- '${name}': ${item.summary}`;
}

export function renderCompletionWake(payload: CompletionWakePayload): string {
  if (payload.ended.length === 1) return renderOne(payload.ended[0]!);
  const head = `${payload.ended.length} workers finished:`;
  return [head, ...payload.ended.map(renderLine)].join("\n");
}
