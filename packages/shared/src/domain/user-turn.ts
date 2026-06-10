import { z } from "zod";

/**
 * Provenance tag for a user turn that clobber synthesized (rather than typed by
 * a human at the composer). Wrapping happens at the serialize chokepoint
 * (`serializeUserMessage`); bareness is reserved as the positive signal that a
 * human composed the turn, so the composer path passes no tag.
 *
 * `via` carries trigger-kind for `type="trigger"` so the enum stays small.
 */
export const USER_TURN_KINDS = [
  "wake-kick",
  "trigger",
  "ask-answer",
  "spawn-prompt",
  "live-inject",
  "interrupt-notice",
  "tool-token",
  "message",
  "message-reply",
  "confirm-resume",
] as const;

export const UserTurnKindSchema = z.enum(USER_TURN_KINDS);
export type UserTurnKind = z.infer<typeof UserTurnKindSchema>;

export const ClobberPromptTagSchema = z.object({
  kind: UserTurnKindSchema,
  attrs: z.record(z.string(), z.string()).optional(),
});
export type ClobberPromptTag = z.infer<typeof ClobberPromptTagSchema>;

/**
 * A complete `<clobber type=…>…</clobber>` turn ready to deliver: the message
 * body plus the provenance tag that wraps it. The unit the notification
 * dispatcher (#425) persists as a payload and hands to the transport.
 */
export const ClobberTurnSchema = z.object({
  body: z.string(),
  tag: ClobberPromptTagSchema,
});
export type ClobberTurn = z.infer<typeof ClobberTurnSchema>;

/** Wraps `content` in `<clobber type="kind" k="v">…</clobber>`. */
export function wrapClobberTag(content: string, tag: ClobberPromptTag): string {
  const attrs = tag.attrs ?? {};
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join("");
  return `<clobber type="${tag.kind}"${attrStr}>${content}</clobber>`;
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Standing guidance composed into every clobber session's system prompt so the
 * agent reads `<clobber type="…">` wrappers as system-origin / possibly-
 * unattended context, and a bare user turn as live human presence. Generic
 * over the `UserTurnKind` enum — meaning, not per-kind policy.
 */
export const CLOBBER_TAG_INTERPRETATION_GUIDANCE = [
  "**Reading user turns.** Clobber wraps any user turn it injects on your",
  "behalf in `<clobber type=\"…\">…</clobber>` (with an optional `via` attribute",
  "carrying further provenance). A wrapped turn is system-origin — clobber",
  "machinery, a trigger, or a relayed answer — and may arrive while no human",
  "is actively watching, so treat it as authoritative context but don't",
  "assume someone is on the other end. A bare user turn (no wrapper) is a",
  "human typing live at the composer. The wrapper is for your interpretation",
  "of incoming turns only; never emit it in your own output.",
  "A `message` turn is a note another agent (a manager) sent you mid-session;",
  "its `token` attr, when present, is a single-use reply capability you may",
  "redeem with `clobber reply <token>` or ignore. A `message-reply` turn is a",
  "worker's one-shot answer arriving back on the manager that opened the thread.",
].join(" ");
