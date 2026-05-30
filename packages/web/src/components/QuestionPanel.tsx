import type { AskQuestion } from "../api.ts";
import { OptionRow } from "./AskOptionControls.tsx";

/**
 * One question's slice of an ask panel: a header chip + prompt, its options
 * (single- or multi-select, each rendering its own preview), and a free-text
 * field. Fully controlled — selection and free-text live in the parent so the
 * panel can gate a single Send-all across every question.
 */
export function QuestionPanel({
  question,
  selected,
  free,
  disabled,
  onToggle,
  onFree,
}: {
  readonly question: AskQuestion;
  readonly selected: readonly string[];
  readonly free: string;
  readonly disabled: boolean;
  readonly onToggle: (label: string) => void;
  readonly onFree: (value: string) => void;
}) {
  const hasOptions = question.options !== undefined && question.options.length > 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="px-1.5 py-0.5 rounded bg-provenance-strong/70 text-provenance-fg text-[10px] uppercase tracking-wider shrink-0">
          {question.header === undefined ? "asking" : question.header}
        </span>
        <p className="text-sm text-provenance-text font-medium leading-snug">
          {question.question}
        </p>
      </div>
      {hasOptions && (
        <div className="flex flex-col gap-1">
          {question.options!.map((opt) => (
            <OptionRow
              key={opt.label}
              option={opt}
              multi={question.multi_select}
              selected={selected.includes(opt.label)}
              disabled={disabled}
              onToggle={() => onToggle(opt.label)}
            />
          ))}
        </div>
      )}
      <input
        type="text"
        value={free}
        onChange={(e) => onFree(e.target.value)}
        disabled={disabled}
        placeholder={hasOptions ? "add a note, or type a custom answer…" : "type an answer…"}
        className="w-full rounded border border-provenance-strong/70 bg-provenance-deep/60 px-2 py-1 text-sm text-provenance-fg placeholder:text-provenance-text/40 focus:outline-none focus:border-provenance"
      />
    </div>
  );
}
