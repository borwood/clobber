import { SessionList } from "../components/SessionList.tsx";
import { useWorkspace } from "../layout/WorkspaceContext.tsx";
import { useLayout } from "../layout/provider.tsx";
import { usePaneId } from "../layout/PaneIdContext.tsx";

export function SessionsView() {
  const w = useWorkspace();
  const { dispatch, setTabDrag } = useLayout();
  const paneId = usePaneId();
  const open = (sessionId: string) =>
    dispatch({ kind: "open_session_tab", sessionId, originatingPaneId: paneId });
  const openInPane = (sessionId: string, x: number, y: number) =>
    setTabDrag({ kind: "insert", view: { kind: "mailbox", sessionId }, x, y });
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <SessionList
        sessions={w.sessions}
        selectedId={w.selectedSession}
        onSelect={open}
        onEnd={w.endSession}
        onResume={w.resumeSession}
        onOpenInPane={openInPane}
      />
    </div>
  );
}
