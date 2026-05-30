import type { AskOption } from "../api.ts";

/**
 * A single selectable option. Single-select questions render these as
 * radio-style buttons (one active at a time); multi-select renders them with a
 * checkbox affordance. Either way the option's rich `preview` (a diagram,
 * mockup, or snippet shipped with the choice) is rendered inline below it — the
 * detail #129 stopped dropping at the bridge.
 */
export function OptionRow({
  option,
  multi,
  selected,
  disabled,
  onToggle,
}: {
  readonly option: AskOption;
  readonly multi: boolean;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={selected}
      disabled={disabled}
      onClick={onToggle}
      className={
        "w-full text-left px-2.5 py-1.5 rounded border text-xs transition-colors " +
        (selected
          ? "border-provenance-text bg-provenance-strong/60 text-provenance-fg"
          : "border-provenance-strong/70 bg-provenance-muted/40 text-provenance-text hover:bg-provenance-strong/60") +
        " disabled:opacity-40 disabled:cursor-not-allowed"
      }
    >
      <div className="flex items-baseline gap-2">
        <span className="shrink-0">{multi ? (selected ? "☑" : "☐") : selected ? "◉" : "○"}</span>
        <span className="font-medium">{option.label}</span>
      </div>
      {option.description !== undefined && (
        <div className="ml-5 text-[10px] text-provenance-text/70 leading-tight">
          {option.description}
        </div>
      )}
      {option.preview !== undefined && (
        <pre className="ml-5 mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-provenance-deep/70 px-2 py-1 text-[10px] leading-snug text-provenance-text/90">
          {option.preview}
        </pre>
      )}
    </button>
  );
}
