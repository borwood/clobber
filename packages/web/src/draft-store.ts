// In-memory composer drafts, keyed by session. A tab is unmounted while
// inactive (only the active pane renders), so the composer's local state can't
// hold an unsent draft across a tab/session switch — this map outlives that
// unmount. Transient by design: drafts do not survive a page reload. Only the
// active tab's composer is mounted at once, so a plain module map suffices —
// no cross-component reactivity needed.
const drafts = new Map<string, string>();

export function getDraft(sessionId: string): string {
  const draft = drafts.get(sessionId);
  return draft === undefined ? "" : draft;
}

// Empty text clears the entry so a never-drafted session reads empty and the
// map doesn't accumulate blank drafts.
export function setDraft(sessionId: string, text: string): void {
  if (text.length === 0) {
    drafts.delete(sessionId);
    return;
  }
  drafts.set(sessionId, text);
}
