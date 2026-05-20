import { useState, type KeyboardEvent } from "react";
import type { AskOption, OpenQuestion } from "../api.ts";

interface Props {
  readonly question: OpenQuestion;
  readonly onAnswer: (answer: string) => Promise<void>;
}

export function AskWidget({ question, onAnswer }: Props) {
  const [free, setFree] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);

  const hasOptions = question.options !== undefined && question.options.length > 0;
  const multi = question.multi_select && hasOptions;

  async function submit(answer: string) {
    if (submitting || answer.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAnswer(answer);
      setFree("");
      setSelected([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function toggleSelected(label: string) {
    setSelected((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
    );
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit(free.trim());
    }
  }

  return (
    <div className="border-t border-amber-700/50 bg-amber-950/40 px-3 py-2.5 space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="px-1.5 py-0.5 rounded bg-amber-700/70 text-amber-50 text-[10px] uppercase tracking-wider shrink-0">
          {question.header === undefined ? "asking" : question.header}
        </span>
        <p className="text-sm text-amber-100 font-medium leading-snug">
          {question.question}
        </p>
      </div>
      {hasOptions && !multi && (
        <div className="flex flex-wrap gap-1.5">
          {question.options!.map((opt) => (
            <OptionButton
              key={opt.label}
              option={opt}
              disabled={submitting}
              onClick={() => void submit(opt.label)}
            />
          ))}
        </div>
      )}
      {hasOptions && multi && (
        <div className="space-y-1.5">
          <div className="flex flex-col gap-1">
            {question.options!.map((opt) => (
              <OptionCheckbox
                key={opt.label}
                option={opt}
                disabled={submitting}
                checked={selected.includes(opt.label)}
                onChange={() => toggleSelected(opt.label)}
              />
            ))}
          </div>
          <button
            type="button"
            disabled={submitting || selected.length === 0}
            onClick={() => void submit(JSON.stringify(selected))}
            className="px-2.5 py-1 text-xs rounded bg-amber-700 text-amber-50 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Sending…" : `Send ${selected.length} selection${selected.length === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={free}
          onChange={(e) => setFree(e.target.value)}
          onKeyDown={onKey}
          disabled={submitting}
          placeholder={hasOptions ? "or type a custom answer…" : "type an answer…"}
          className="flex-1 rounded border border-amber-800/70 bg-amber-950/60 px-2 py-1 text-sm text-amber-50 placeholder:text-amber-200/40 focus:outline-none focus:border-amber-600"
        />
        <button
          type="button"
          disabled={submitting || free.trim().length === 0}
          onClick={() => void submit(free.trim())}
          className="px-2.5 py-1 text-xs rounded bg-amber-700 text-amber-50 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? "Sending…" : "Send"}
        </button>
      </div>
      {error !== null && (
        <p className="text-xs text-red-400 truncate" title={error}>
          {error}
        </p>
      )}
    </div>
  );
}

function OptionButton({
  option,
  disabled,
  onClick,
}: {
  readonly option: AskOption;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={renderOptionTitle(option)}
      className="px-2.5 py-1 text-xs rounded bg-amber-800 text-amber-50 hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed text-left"
    >
      <div className="font-medium">{option.label}</div>
      {option.description !== undefined && (
        <div className="text-[10px] text-amber-200/70 leading-tight">
          {option.description}
        </div>
      )}
    </button>
  );
}

function OptionCheckbox({
  option,
  disabled,
  checked,
  onChange,
}: {
  readonly option: AskOption;
  readonly disabled: boolean;
  readonly checked: boolean;
  readonly onChange: () => void;
}) {
  return (
    <label
      className="flex items-start gap-2 text-xs text-amber-100 cursor-pointer"
      title={renderOptionTitle(option)}
    >
      <input
        type="checkbox"
        disabled={disabled}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 accent-amber-600"
      />
      <span className="flex flex-col">
        <span className="font-medium">{option.label}</span>
        {option.description !== undefined && (
          <span className="text-[10px] text-amber-200/70 leading-tight">
            {option.description}
          </span>
        )}
      </span>
    </label>
  );
}

function renderOptionTitle(option: AskOption): string {
  if (option.preview !== undefined) return option.preview;
  if (option.description !== undefined) return option.description;
  return option.label;
}
