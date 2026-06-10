import { useState } from "react";

interface Props {
  readonly markdownPreview: boolean;
  readonly onToggleMarkdownPreview: () => void;
}

// The 3-dot composer-options popover. Self-contained: owns its open/closed
// state and click-away; each option is a toggle row driven by parent state.
export function ComposerOptionsMenu({ markdownPreview, onToggleMarkdownPreview }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Composer options"
        className="px-2 py-1.5 text-xs rounded border border-border text-text-soft hover:text-text hover:border-border-strong"
      >
        ⋯
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 mb-1 z-20 w-52 rounded border border-border bg-surface p-1 shadow-lg">
            <button
              type="button"
              onClick={onToggleMarkdownPreview}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-xs text-text-soft hover:bg-elevated"
            >
              <span>Markdown preview</span>
              <span className={markdownPreview ? "text-accent-text" : "text-text-faint"}>
                {markdownPreview ? "On" : "Off"}
              </span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
