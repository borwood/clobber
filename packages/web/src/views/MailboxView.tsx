import { MailboxContent } from "../components/MailboxContent.tsx";
import { useWorkspace } from "../layout/WorkspaceContext.tsx";
import { useTranscript } from "../hooks/useTranscript.ts";

interface Props {
  readonly sessionId: string;
}

export function MailboxView({ sessionId }: Props) {
  const w = useWorkspace();
  if (w.invalidWorkspace) {
    return (
      <p className="text-sm text-zinc-500 p-4">
        Workspace not found. Pick one above or create a new workspace.
      </p>
    );
  }
  const transcript = useTranscript(sessionId);
  return (
    <MailboxContent
      sessions={w.sessions}
      selectedSession={sessionId}
      transcript={transcript}
      showSystem={w.showSystem}
      setShowSystem={w.setShowSystem}
    />
  );
}
