import type { InlineFormat } from "./markdown-format.ts";

export interface ComposerKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

// "send" / "interrupt" are composer-level actions; the inline-format actions
// hand off to the markdown-format substrate; "newline" / "ignore" let the
// editor handle the key natively (typed character, native line break).
export type ComposerKeyAction =
  | "send"
  | "interrupt"
  | "newline"
  | "ignore"
  | InlineFormat;

// Mod+Enter sends so a bare Enter is free to insert a real line break — that is
// what lets a typed blank line become a markdown paragraph break, which the old
// Enter-to-send composer could only fake with a trailing backslash.
export function classifyComposerKey(
  e: ComposerKeyEvent,
  caps: { readonly hasTextSelection: boolean },
): ComposerKeyAction {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if (k === "Enter") {
    if (mod) return "send";
    return "newline";
  }

  if (k === "c" && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && !caps.hasTextSelection) {
    return "interrupt";
  }

  if (mod && !e.altKey) {
    if (!e.shiftKey && k === "b") return "bold";
    if (!e.shiftKey && k === "i") return "italic";
    if (!e.shiftKey && k === "e") return "code";
    if (e.shiftKey && k === "x") return "strikethrough";
  }

  return "ignore";
}
