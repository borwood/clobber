import type { LayoutEvent } from "@clobber/shared";
import type { Action } from "./reducer.ts";

/**
 * The reusable seam of the server→web layout bridge (#326): translate a
 * server-emitted `layout` event into a local reducer action. Keeping wire and
 * reducer vocabularies separate means a new server-driven layout change (#246
 * sticky tabs) adds a `LayoutEvent` action type and one case here — not a new
 * dispatch path. The `switch` is exhaustive over the action union, so a new
 * action type is a compile error until it is handled.
 */
export function layoutEventToAction(event: LayoutEvent): Action {
  switch (event.action.type) {
    case "swap_session_tab":
      return {
        kind: "swap_session_tab",
        oldSessionId: event.action.oldSessionId,
        newSessionId: event.action.newSessionId,
      };
  }
}
