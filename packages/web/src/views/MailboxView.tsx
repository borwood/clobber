import { MailboxContent } from "../components/MailboxContent.tsx";
import { useWorkspace } from "../layout/WorkspaceContext.tsx";

export function MailboxView() {
  const w = useWorkspace();
  if (w.invalidWorkspace) {
    return (
      <p className="text-sm text-zinc-500 p-4">
        Workspace not found. Pick one above or create a new workspace.
      </p>
    );
  }
  return (
    <MailboxContent
      sessions={w.sessions}
      selectedSession={w.selectedSession}
      transcript={w.transcript}
      showSystem={w.showSystem}
      setShowSystem={w.setShowSystem}
    />
  );
}
