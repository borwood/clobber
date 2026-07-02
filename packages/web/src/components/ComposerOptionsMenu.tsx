import { useState } from "react";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import type { SessionReconfigureRequest } from "../api.ts";
import { EFFORT_LEVELS, MODEL_OPTIONS } from "../model-effort-options.ts";

interface Props {
  readonly richMarkdown: boolean;
  readonly onToggleRichMarkdown: () => void;
  readonly showDetails: boolean;
  readonly onToggleShowDetails: () => void;
  readonly canEndSession: boolean;
  readonly onEndSession: () => void;
  // The session's current dials; undefined = never recorded (role default).
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly onReconfigure: (change: SessionReconfigureRequest) => void;
}

// The 3-dot composer-options popover. Self-contained: owns its open/closed
// state and click-away; each option is a toggle row driven by parent state,
// plus the live model/effort dials (same options as the spawn panel).
export function ComposerOptionsMenu({
  richMarkdown,
  onToggleRichMarkdown,
  showDetails,
  onToggleShowDetails,
  canEndSession,
  onEndSession,
  model,
  effort,
  onReconfigure,
}: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Composer options"
        className="px-2 py-1.5 rounded border border-border text-text-soft hover:text-text hover:border-border-strong flex items-center"
      >
        <DotsThreeIcon size={16} weight="bold" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 mb-1 z-20 w-52 rounded border border-border bg-surface p-1 shadow-lg">
            <ToggleRow label="Markdown styling" on={richMarkdown} onToggle={onToggleRichMarkdown} />
            <ToggleRow label="Show details" on={showDetails} onToggle={onToggleShowDetails} />
            <DialRow
              label="Model"
              value={model}
              options={MODEL_OPTIONS}
              onChange={(v) => onReconfigure({ model: v })}
            />
            <DialRow
              label="Effort"
              value={effort}
              options={EFFORT_LEVELS}
              onChange={(v) => onReconfigure({ effort: v })}
            />
            {canEndSession && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onEndSession();
                }}
                className="mt-1 flex w-full items-center rounded border-t border-border px-2 pt-2 pb-1.5 text-xs text-danger-text hover:bg-elevated"
              >
                End session
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ToggleRow({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-xs text-text-soft hover:bg-elevated"
    >
      <span>{label}</span>
      <span className={on ? "text-accent-text" : "text-text-faint"}>{on ? "On" : "Off"}</span>
    </button>
  );
}

function DialRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-xs text-text-soft hover:bg-elevated">
      <span>{label}</span>
      <select
        value={value === undefined ? "" : value}
        onChange={(e) => onChange(e.target.value as T)}
        className="rounded border border-border bg-surface px-1 py-0.5 text-xs text-text focus:outline-none focus:border-border-strong"
      >
        {value === undefined && (
          <option value="" disabled>
            —
          </option>
        )}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
