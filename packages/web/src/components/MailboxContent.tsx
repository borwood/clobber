import {
  api,
  type SessionSummary,
  type TranscriptLine,
} from "../api.ts";
import { AskWidget } from "./AskWidget.tsx";
import { PromptComposer } from "./PromptComposer.tsx";
import { SessionHeader } from "./SessionHeader.tsx";
import { TranscriptViewer } from "./TranscriptViewer.tsx";

interface MailboxContentProps {
  readonly sessions: readonly SessionSummary[];
  readonly selectedSession: string | null;
  readonly transcript: readonly TranscriptLine[];
  readonly showSystem: boolean;
  readonly setShowSystem: (b: boolean) => void;
}

export function MailboxContent(props: MailboxContentProps) {
  const { sessions, selectedSession, transcript, showSystem, setShowSystem } =
    props;

  const selected =
    selectedSession === null
      ? undefined
      : sessions.find((s) => s.session_id === selectedSession);

  const detailsCheckbox = (
    <label className="flex items-center gap-2 text-xs text-zinc-500 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={showSystem}
        onChange={(e) => setShowSystem(e.target.checked)}
        className="accent-emerald-600"
      />
      show details
    </label>
  );

  return (
    <>
      {selected === undefined ? (
        <div className="flex items-center px-6 py-3 shrink-0">
          <h2 className="text-sm uppercase tracking-wider text-zinc-500">
            select a session
          </h2>
          <span className="ml-auto">{detailsCheckbox}</span>
        </div>
      ) : (
        <div className="flex items-stretch shrink-0">
          <div className="flex-1 min-w-0">
            <SessionHeader session={selected} />
          </div>
          <div className="flex items-center px-6 border-l border-zinc-800">
            {detailsCheckbox}
          </div>
        </div>
      )}
      <TranscriptViewer
        key={selectedSession ?? "none"}
        lines={transcript}
        showSystem={showSystem}
        busy={selected?.busy === true}
      />
      {selectedSession !== null && selected !== undefined && (
        <>
          {selected.open_question !== undefined && (
            <AskWidget
              question={selected.open_question}
              onAnswer={async (answer) => {
                await api.answerQuestion(
                  selectedSession,
                  selected.open_question!.id,
                  answer,
                );
              }}
            />
          )}
          <PromptComposer
            key={selectedSession}
            sessionId={selectedSession}
            disabled={selected.ended_at !== undefined}
            busy={selected.busy === true}
            onSend={async (prompt) => {
              await api.sendPrompt(selectedSession, prompt);
            }}
            onInterrupt={async () => {
              await api.interruptSession(selectedSession);
            }}
          />
        </>
      )}
    </>
  );
}
