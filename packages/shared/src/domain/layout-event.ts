import { z } from "zod";

/**
 * Server→web layout-dispatch bridge (#326). A `layout` event is the general
 * envelope a server-driven layout mutation rides on; `action` is a discriminated
 * union so new server-driven layout changes (e.g. #246 sticky tabs) add an
 * action type without minting a new event. The first action swaps the session a
 * mailbox tab points at — used by `clobber cycle` (#320) to re-target a tab when
 * a session is cycled, without the user touching the floor.
 */
export const SwapSessionTabActionSchema = z.object({
  type: z.literal("swap_session_tab"),
  oldSessionId: z.string().min(1),
  newSessionId: z.string().min(1),
});
export type SwapSessionTabAction = z.infer<typeof SwapSessionTabActionSchema>;

export const LayoutActionSchema = z.discriminatedUnion("type", [
  SwapSessionTabActionSchema,
]);
export type LayoutAction = z.infer<typeof LayoutActionSchema>;

export const LayoutEventSchema = z.object({
  kind: z.literal("layout"),
  action: LayoutActionSchema,
});
export type LayoutEvent = z.infer<typeof LayoutEventSchema>;

/**
 * Layout events ride the existing HTTP-poll transport (there is no WebSocket in
 * this codebase), so each carries a per-workspace monotonic `seq`. A client
 * polls with `?since=<seq>` and the server returns the events past that cursor;
 * the client advances its own cursor to the highest `seq` it applied. The
 * cursor is purely client-side, so every open client receives and applies the
 * event, and an empty poll is just `[]`.
 */
export interface SequencedLayoutEvent {
  readonly seq: number;
  readonly event: LayoutEvent;
}
