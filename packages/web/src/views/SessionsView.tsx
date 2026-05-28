import { SessionList } from "../components/SessionList.tsx";
import { useWorkspace } from "../layout/WorkspaceContext.tsx";

export function SessionsView() {
  const w = useWorkspace();
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <SessionList
        sessions={w.sessions}
        selectedId={w.selectedSession}
        onSelect={w.focusSession}
        onEnd={w.endSession}
        onResume={w.resumeSession}
      />
    </div>
  );
}
