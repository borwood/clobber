import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { classifyComposerKey } from "./composer-key.ts";
import { computeFormat, type MarkdownFormat } from "./markdown-format.ts";

export interface MarkdownEditorHandle {
  applyFormat(format: MarkdownFormat): void;
  focus(): void;
}

export type ComposerAction = "send" | "interrupt";

interface Props {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onAction: (action: ComposerAction) => void;
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly richMarkdown: boolean;
  readonly minHeight: string;
  readonly maxHeight: number;
  readonly onFocusChange?: (focused: boolean) => void;
}

// Source-mode-with-styling: the markdown markers stay in the text (caret-stable)
// but headings, emphasis, code, links etc. render their effect inline. Marker
// punctuation is dimmed rather than hidden so what is typed always matches what
// renders. Colors ride the same CSS variables as the rest of the app.
const markdownHighlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "600", fontSize: "1.3em" },
  { tag: t.heading2, fontWeight: "600", fontSize: "1.15em" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "600" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.monospace, fontFamily: "ui-monospace, monospace", color: "var(--color-accent-ink)" },
  { tag: [t.link, t.url], color: "var(--color-accent-text)", textDecoration: "underline" },
  { tag: t.quote, color: "var(--color-text-muted)", fontStyle: "italic" },
  { tag: t.processingInstruction, color: "var(--color-text-faint)" },
]);

function editorTheme(minHeight: string, maxHeight: number) {
  return EditorView.theme({
    "&": {
      fontSize: "0.875rem",
      color: "var(--color-text)",
      backgroundColor: "transparent",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "inherit",
      lineHeight: "1.5",
      overflowY: "auto",
      maxHeight: `${maxHeight}px`,
    },
    ".cm-content": {
      minHeight,
      padding: "0.5rem 0",
      caretColor: "var(--color-text)",
    },
    ".cm-line": { padding: "0 0.75rem" },
    ".cm-cursor": { borderLeftColor: "var(--color-text)" },
    ".cm-placeholder": { color: "var(--color-text-faint)" },
    "&.cm-editor.cm-focused .cm-selectionBackground, & .cm-selectionBackground": {
      backgroundColor: "var(--color-elevated)",
    },
  });
}

function dispatchFormat(view: EditorView, format: MarkdownFormat) {
  const { from, to } = view.state.selection.main;
  const change = computeFormat(view.state.doc.toString(), { from, to }, format);
  view.dispatch({
    changes: change.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
    selection: { anchor: change.selection.from, head: change.selection.to },
    scrollIntoView: true,
  });
  view.focus();
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(
  { value, onChange, onAction, disabled, placeholder, richMarkdown, minHeight, maxHeight, onFocusChange },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onActionRef = useRef(onAction);
  const onFocusChangeRef = useRef(onFocusChange);
  onChangeRef.current = onChange;
  onActionRef.current = onAction;
  onFocusChangeRef.current = onFocusChange;

  const highlight = useRef(new Compartment()).current;
  const editable = useRef(new Compartment()).current;
  const themeC = useRef(new Compartment()).current;
  const placeholderC = useRef(new Compartment()).current;

  useImperativeHandle(ref, () => ({
    applyFormat(format) {
      const view = viewRef.current;
      if (view === null) return;
      dispatchFormat(view, format);
    },
    focus() {
      viewRef.current?.focus();
    },
  }));

  // Build the view exactly once. All mutable inputs flow in through refs or
  // compartments so React re-renders never tear the editor down (which would
  // drop caret + undo history mid-edit).
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          markdown(),
          highlight.of(richMarkdown ? syntaxHighlighting(markdownHighlight) : []),
          editable.of(EditorView.editable.of(!disabled)),
          themeC.of(editorTheme(minHeight, maxHeight)),
          placeholderC.of(cmPlaceholder(placeholder)),
          EditorView.lineWrapping,
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (e, v) => {
                const action = classifyComposerKey(e, {
                  hasTextSelection: !v.state.selection.main.empty,
                });
                if (action === "send") {
                  e.preventDefault();
                  onActionRef.current("send");
                  return true;
                }
                if (action === "interrupt") {
                  e.preventDefault();
                  onActionRef.current("interrupt");
                  return true;
                }
                if (action === "newline" || action === "ignore") return false;
                e.preventDefault();
                dispatchFormat(v, action);
                return true;
              },
            }),
          ),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
            if (u.focusChanged) onFocusChangeRef.current?.(u.view.hasFocus);
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push external value changes (draft restore, post-send clear) into the view
  // without disturbing the caret when the value already matches.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: highlight.reconfigure(richMarkdown ? syntaxHighlighting(markdownHighlight) : []),
    });
  }, [richMarkdown, highlight]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editable.reconfigure(EditorView.editable.of(!disabled)),
    });
  }, [disabled, editable]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeC.reconfigure(editorTheme(minHeight, maxHeight)),
    });
  }, [minHeight, maxHeight, themeC]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: placeholderC.reconfigure(cmPlaceholder(placeholder)),
    });
  }, [placeholder, placeholderC]);

  return <div ref={hostRef} className={disabled ? "opacity-50" : undefined} />;
});
