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

  return (
    <>
      {selected === undefined ? (
        <div className="flex items-center px-6 py-3 shrink-0">
          <h2 className="text-sm uppercase tracking-wider text-text-subtle">
            select a session
          </h2>
        </div>
      ) : (
        <div className="shrink-0">
          <SessionHeader session={selected} />
        </div>
      )}
      <TranscriptViewer
        key={selectedSession ?? "none"}
        lines={transcript}
        showSystem={showSystem}
        busy={selected?.busy === true}
        session={selected}
      />
      {selectedSession !== null && selected !== undefined && (
        <>
          {selected.open_question !== undefined && (
            <AskWidget
              key={selected.open_question.id}
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
            ended={selected.ended_at !== undefined}
            busy={selected.busy === true}
            transcript={transcript}
            showDetails={showSystem}
            onToggleShowDetails={() => setShowSystem(!showSystem)}
            onSend={async (prompt) => {
              await api.sendPrompt(selectedSession, prompt);
            }}
            onResume={async (prompt) => {
              await api.resumeSession(selectedSession, prompt);
            }}
            onInterrupt={async () => {
              await api.interruptSession(selectedSession);
            }}
            onEndSession={async () => {
              await api.endSession(selectedSession);
            }}
          />
        </>
      )}
    </>
  );
}
