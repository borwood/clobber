// The payload a `session-ended` trigger carries into the manager's wake, and
// how it renders into the synthesized prompt. Built by the scheduler's
// fireSessionEnded from persistent state (session row + final-report row) and
// coalesced across multiple completions when the manager was busy. See #171.

export interface SessionEndedItem {
  readonly sessionId: string;
  readonly label: string | null;
  // The finished session's final-report summary, or null when the session
  // ended without a report (crash / kill) — which the manager triages.
  readonly summary: string | null;
}

export interface SessionEndedWakePayload {
  readonly ended: readonly SessionEndedItem[];
}

function nameOf(item: SessionEndedItem): string {
  return item.label === null ? item.sessionId : item.label;
}

function renderOne(item: SessionEndedItem): string {
  const name = nameOf(item);
  return item.summary === null
    ? `worker '${name}' ended with no report — possible crash/kill, triage`
    : `worker '${name}' finished: ${item.summary}`;
}

function renderLine(item: SessionEndedItem): string {
  const name = nameOf(item);
  return item.summary === null
    ? `- '${name}': ended with no report (triage)`
    : `- '${name}': ${item.summary}`;
}

export function renderSessionEndedWake(payload: SessionEndedWakePayload): string {
  if (payload.ended.length === 1) return renderOne(payload.ended[0]!);
  const head = `${payload.ended.length} workers finished:`;
  return [head, ...payload.ended.map(renderLine)].join("\n");
}
