import { useState } from "react";
import { encodePanelAnswer, type PanelAnswerPart } from "@clobber/shared";
import type { OpenQuestion } from "../api.ts";
import { QuestionPanel } from "./QuestionPanel.tsx";

interface Props {
  readonly question: OpenQuestion;
  readonly onAnswer: (answer: string) => Promise<void>;
}

/**
 * Renders an ask as a single stacked panel — one {@link QuestionPanel} per
 * question (1–4) — and gates a single Send-all on every required question being
 * answered. The whole ask is one open question to the rest of the UI; this is
 * the only place it fans out to N. Submission re-collapses the per-question
 * answers via {@link encodePanelAnswer}, so a one-question ask sends the exact
 * bare answer string `clobber ask` has always received.
 */
export function AskWidget({ question, onAnswer }: Props) {
  const questions = question.questions;
  const [selected, setSelected] = useState<readonly string[][]>(() =>
    questions.map(() => []),
  );
  const [free, setFree] = useState<readonly string[]>(() =>
    questions.map(() => ""),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(index: number, label: string): void {
    setSelected((prev) =>
      prev.map((sel, i) => {
        if (i !== index) return sel;
        if (questions[index]!.multi_select) {
          return sel.includes(label)
            ? sel.filter((l) => l !== label)
            : [...sel, label];
        }
        return sel.includes(label) ? [] : [label];
      }),
    );
  }

  function setFreeAt(index: number, value: string): void {
    setFree((prev) => prev.map((f, i) => (i === index ? value : f)));
  }

  function answered(index: number): boolean {
    return selected[index]!.length > 0 || free[index]!.trim().length > 0;
  }

  const allAnswered = questions.every((_, i) => answered(i));

  function buildPart(index: number): PanelAnswerPart {
    const sel = selected[index]!;
    const note = free[index]!.trim();
    if (sel.length === 0) return { raw: note };
    const raw = questions[index]!.multi_select ? JSON.stringify(sel) : sel[0]!;
    return note.length === 0 ? { raw } : { raw, notes: note };
  }

  async function submit(): Promise<void> {
    if (submitting || !allAnswered) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAnswer(encodePanelAnswer(questions.map((_, i) => buildPart(i))));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const label =
    questions.length === 1 ? "Send" : `Send ${questions.length} answers`;

  return (
    <div className="border-t border-amber-700/50 bg-amber-950/40 px-3 py-2.5 space-y-3">
      {questions.map((q, i) => (
        <QuestionPanel
          key={i}
          question={q}
          selected={selected[i]!}
          free={free[i]!}
          disabled={submitting}
          onToggle={(opt) => toggle(i, opt)}
          onFree={(value) => setFreeAt(i, value)}
        />
      ))}
      <button
        type="button"
        disabled={submitting || !allAnswered}
        onClick={() => void submit()}
        className="px-2.5 py-1 text-xs rounded bg-amber-700 text-amber-50 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {submitting ? "Sending…" : label}
      </button>
      {error !== null && (
        <p className="text-xs text-red-400 truncate" title={error}>
          {error}
        </p>
      )}
    </div>
  );
}
