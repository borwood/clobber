import { act } from "react";
import { EditorView } from "@codemirror/view";

// Drive the composer's real CodeMirror editor in tests through CM's public
// surface: findFromDOM resolves the live EditorView from any node inside it, so
// we can dispatch document changes and keystrokes exactly as the browser would,
// then read the document straight back.
export function getView(container: HTMLElement): EditorView {
  const el = container.querySelector(".cm-editor");
  if (el === null) throw new Error("no .cm-editor mounted");
  const view = EditorView.findFromDOM(el as HTMLElement);
  if (view === null) throw new Error("no EditorView attached to .cm-editor");
  return view;
}

export function editorText(container: HTMLElement): string {
  return getView(container).state.doc.toString();
}

export async function typeInto(container: HTMLElement, value: string): Promise<void> {
  const view = getView(container);
  await act(async () => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  });
}

export async function pressKey(
  container: HTMLElement,
  init: KeyboardEventInit,
): Promise<void> {
  const content = container.querySelector(".cm-content");
  if (content === null) throw new Error("no .cm-content mounted");
  await act(async () => {
    content.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
    // Flush any async send()/resume() the keydown fired via `void`.
    await new Promise((r) => setTimeout(r, 10));
  });
}
