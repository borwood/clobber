import { WhiteboardView as WhiteboardViewBody } from "../components/WhiteboardView.tsx";
import { useWorkspace } from "../layout/WorkspaceContext.tsx";
import { useLayout } from "../layout/provider.tsx";

export function WhiteboardView() {
  const w = useWorkspace();
  const { focusView } = useLayout();
  return (
    <WhiteboardViewBody
      offices={w.offices}
      desks={w.desks}
      now={w.now}
      wakingAgentIds={w.wakingAgents}
      onOpenSession={(focusId) => {
        focusView("mailbox");
        w.focusSession(focusId);
      }}
      onWake={async (agentId, wakeProgram) => {
        await w.wakeAgent(agentId, wakeProgram);
        focusView("mailbox");
      }}
    />
  );
}
