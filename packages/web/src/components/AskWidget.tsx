import { useState, type KeyboardEvent } from "react";
import type { OpenQuestion } from "../api.ts";

interface Props {
  readonly question: OpenQuestion;
  readonly onAnswer: (answer: string) => Promise<void>;
}

export function AskWidget({ question, onAnswer }: Props) {
  const [free, setFree] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(answer: string) {
    if (submitting || answer.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAnswer(answer);
      setFree("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit(free.trim());
    }
  }

  const hasOptions = question.options !== undefined && question.options.length > 0;

  return (
    <div className="border-t border-amber-700/50 bg-amber-950/40 px-3 py-2.5 space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="px-1.5 py-0.5 rounded bg-amber-700/70 text-amber-50 text-[10px] uppercase tracking-wider shrink-0">
          asking
        </span>
        <p className="text-sm text-amber-100 font-medium leading-snug">
          {question.question}
        </p>
      </div>
      {hasOptions && (
        <div className="flex flex-wrap gap-1.5">
          {question.options!.map((opt) => (
            <button
              key={opt}
              type="button"
              disabled={submitting}
              onClick={() => void submit(opt)}
              className="px-2.5 py-1 text-xs rounded bg-amber-800 text-amber-50 hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {opt}
            </button>
          ))}
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
