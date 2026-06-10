import { WhiteboardView as WhiteboardViewBody } from "../components/WhiteboardView.tsx";
import { useWorkspace } from "../layout/WorkspaceContext.tsx";
import { useLayout } from "../layout/provider.tsx";
import { usePaneId } from "../layout/PaneIdContext.tsx";

export function WhiteboardView() {
  const w = useWorkspace();
  const { dispatch, setTabDrag, focusView } = useLayout();
  const paneId = usePaneId();
  return (
    <WhiteboardViewBody
      offices={w.offices}
      desks={w.desks}
      now={w.now}
      wakingAgentIds={w.wakingAgents}
      onOpenSession={(sessionId) =>
        dispatch({ kind: "open_session_tab", sessionId, originatingPaneId: paneId })
      }
      onOpenInPane={(sessionId, x, y) =>
        setTabDrag({ kind: "insert", view: { kind: "mailbox", sessionId }, x, y })
      }
      onWake={async (agentId, wakeProgram) => {
        await w.wakeAgent(agentId, wakeProgram);
        focusView("mailbox");
      }}
    />
  );
}
