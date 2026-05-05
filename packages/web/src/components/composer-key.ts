export interface ComposerKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

export type ComposerKeyAction = "send" | "interrupt" | "newline" | "ignore";

export function classifyComposerKey(
  e: ComposerKeyEvent,
  caps: { readonly hasTextSelection: boolean },
): ComposerKeyAction {
  if (e.key === "Enter") {
    if (e.shiftKey) return "newline";
    if (e.ctrlKey || e.metaKey || e.altKey) return "ignore";
    return "send";
  }
  if (
    e.key === "c" &&
    e.ctrlKey &&
    !e.metaKey &&
    !e.shiftKey &&
    !e.altKey &&
    !caps.hasTextSelection
  ) {
    return "interrupt";
  }
  return "ignore";
}
