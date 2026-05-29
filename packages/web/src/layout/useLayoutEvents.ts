import { useEffect, useRef } from "react";
import { api } from "../api.ts";
import { layoutEventToAction } from "./layout-event-bridge.ts";
import type { Action } from "./reducer.ts";

/**
 * The provider's subscription to the server→web layout bridge (#326). It rides
 * the same HTTP-poll transport every other live view uses — there is no socket —
 * tracking a per-client cursor so each open client applies every event exactly
 * once. Dispatches flow through the normal layout reducer, so a server-driven
 * swap persists to localStorage like any local mutation.
 *
 * `dispatch` is read through a ref so a layout change (which re-creates the
 * provider's dispatch callback) doesn't tear down the poll and reset the cursor.
 */
export function useLayoutEvents(
  workspaceId: string | null,
  dispatch: (a: Action) => void,
  intervalMs: number = 1000,
): void {
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  useEffect(() => {
    if (workspaceId === null) return;
    let cursor = 0;
    let cancelled = false;
    async function tick() {
      const events = await api.getLayoutEvents(workspaceId!, cursor);
      if (cancelled) return;
      for (const e of events) {
        dispatchRef.current(layoutEventToAction(e.event));
        cursor = e.seq;
      }
    }
    void tick();
    const id = setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [workspaceId, intervalMs]);
}
