/**
 * Provenance tag for a user turn that clobber synthesized (rather than typed by
 * a human at the composer). Wrapping happens at the serialize chokepoint
 * (`serializeUserMessage`); bareness is reserved as the positive signal that a
 * human composed the turn, so the composer path passes no tag.
 *
 * `via` carries trigger-kind for `type="trigger"` so the enum stays small.
 */
export type UserTurnKind =
  | "wake-kick"
  | "trigger"
  | "ask-answer"
  | "spawn-prompt"
  | "live-inject"
  | "interrupt-notice";

export interface ClobberPromptTag {
  readonly kind: UserTurnKind;
  readonly attrs?: Readonly<Record<string, string>>;
}

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
].join(" ");
