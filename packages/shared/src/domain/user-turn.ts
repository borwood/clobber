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
