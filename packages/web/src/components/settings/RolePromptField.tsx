import { useState } from "react";
import { Markdown } from "../Markdown.tsx";
import type { OverrideProps } from "./SchemaField.tsx";

// Bespoke editor for a role's system_prompt: a tall monospace textarea with a
// markdown preview toggle. The default StringControl is a single-line input —
// useless for a multi-paragraph prompt — so this override pre-empts it.
export function RolePromptField({ value, onChange }: OverrideProps) {
  const text = typeof value === "string" ? value : "";
  const [preview, setPreview] = useState(false);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setPreview((p) => !p)}
          className="text-[11px] text-text-muted hover:text-text-dim"
        >
          {preview ? "edit" : "preview"}
        </button>
      </div>
      {preview ? (
        <div className="rounded border border-border bg-surface px-3 py-2 min-h-[12rem] max-h-[28rem] overflow-y-auto">
          {text.trim() === "" ? (
            <span className="text-xs text-text-faint">nothing to preview</span>
          ) : (
            <Markdown text={text} />
          )}
        </div>
      ) : (
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className="rounded border border-border bg-surface px-2 py-1.5 text-xs text-text font-mono w-full min-h-[12rem] max-h-[28rem] resize-y focus:outline-none focus:border-border-strong"
        />
      )}
    </div>
  );
}
