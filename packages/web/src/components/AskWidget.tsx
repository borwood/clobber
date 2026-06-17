import { useState } from "react";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { encodePanelAnswer, type PanelAnswerPart } from "@clobber/shared";
import type { OpenQuestion } from "../api.ts";
import { QuestionPanel } from "./QuestionPanel.tsx";
import { Tabs } from "../layout/Tabs.tsx";
import { ActionButton } from "./ActionButton.tsx";

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
  const [active, setActive] = useState(0);

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

  const timedOut = question.status === "timed_out";
  const label = timedOut
    ? "Send anyway"
    : questions.length === 1
      ? "Send"
      : `Send ${questions.length} answers`;

  return (
    <div className="border-t border-provenance-strong/50 bg-provenance-deep/40 px-3 py-2.5 space-y-3">
      {timedOut && (
        <p className="text-xs text-provenance-text/90">
          This ask timed out — your answer will be sent to the agent as a new
          message.
        </p>
      )}
      {questions.length > 1 && (
        <Tabs
          variant="ask"
          ariaLabel="Questions"
          activeId={String(active)}
          onSelect={(id) => setActive(Number(id))}
          tabs={questions.map((q, i) => ({
            id: String(i),
            label: (
              <span className="inline-flex items-center gap-1.5">
                {q.header === undefined ? `Q${i + 1}` : q.header}
                <span className={answered(i) ? "text-provenance-text inline-flex" : "text-provenance-text/40"}>
                  {answered(i) ? <CheckIcon size={12} weight="bold" /> : "•"}
                </span>
              </span>
            ),
          }))}
        />
      )}
      {questions.map((q, i) =>
        questions.length > 1 && i !== active ? null : (
          <QuestionPanel
            key={i}
            question={q}
            selected={selected[i]!}
            free={free[i]!}
            disabled={submitting}
            onToggle={(opt) => toggle(i, opt)}
            onFree={(value) => setFreeAt(i, value)}
          />
        ),
      )}
      <ActionButton
        variant="provenance"
        disabled={submitting || !allAnswered}
        onClick={() => void submit()}
        className="px-2.5 py-1 text-xs"
      >
        {submitting ? "Sending…" : label}
      </ActionButton>
      {error !== null && (
        <p className="text-xs text-danger-text truncate" title={error}>
          {error}
        </p>
      )}
    </div>
  );
}
