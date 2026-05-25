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
        <span className="px-1.5 py-0.5 rounded bg-amber-700/70 text-amber-50 text-[10px] uppercase tracking-wider shrink-0">
          {question.header === undefined ? "asking" : question.header}
        </span>
        <p className="text-sm text-amber-100 font-medium leading-snug">
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
        className="w-full rounded border border-amber-800/70 bg-amber-950/60 px-2 py-1 text-sm text-amber-50 placeholder:text-amber-200/40 focus:outline-none focus:border-amber-600"
      />
    </div>
  );
}
