import type {
  LayoutAction,
  SequencedLayoutEvent,
} from "@clobber/shared";

/**
 * In-memory bus for server→web layout events (#326). It is transient on purpose:
 * a layout event re-targets live UI (which tab points at which session); there
 * is nothing to replay across a server restart, so it never touches SQLite.
 *
 * `emit` is the producer seam — `clobber cycle` (#320) and sticky tabs (#246)
 * call it to drive a client layout mutation. Each workspace gets its own
 * monotonic `seq`; clients poll `since(workspaceId, cursor)` and apply events
 * past their own cursor, so every open client receives the change.
 */
export interface LayoutEventStore {
  emit(workspaceId: string, action: LayoutAction): SequencedLayoutEvent;
  since(workspaceId: string, cursor: number): readonly SequencedLayoutEvent[];
}

interface WorkspaceLog {
  seq: number;
  events: SequencedLayoutEvent[];
}

const DEFAULT_RETAINED = 200;

export function createLayoutEventStore(retained = DEFAULT_RETAINED): LayoutEventStore {
  const logs = new Map<string, WorkspaceLog>();

  function logFor(workspaceId: string): WorkspaceLog {
    const existing = logs.get(workspaceId);
    if (existing !== undefined) return existing;
    const created: WorkspaceLog = { seq: 0, events: [] };
    logs.set(workspaceId, created);
    return created;
  }

  return {
    emit(workspaceId, action) {
      const log = logFor(workspaceId);
      log.seq += 1;
      const entry: SequencedLayoutEvent = {
        seq: log.seq,
        event: { kind: "layout", action },
      };
      log.events.push(entry);
      if (log.events.length > retained) {
        log.events.splice(0, log.events.length - retained);
      }
      return entry;
    },
    since(workspaceId, cursor) {
      const log = logs.get(workspaceId);
      if (log === undefined) return [];
      return log.events.filter((e) => e.seq > cursor);
    },
  };
}
