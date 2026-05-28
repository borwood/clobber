import { SessionList } from "../components/SessionList.tsx";
import { useWorkspace } from "../layout/WorkspaceContext.tsx";
import { useLayout } from "../layout/provider.tsx";
import type { LayoutNode, PaneNode } from "../layout/types.ts";

export function SessionsView() {
  const w = useWorkspace();
  const { layout, dispatch } = useLayout();
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <SessionList
        sessions={w.sessions}
        selectedId={w.selectedSession}
        onSelect={w.focusSession}
        onEnd={w.endSession}
        onResume={w.resumeSession}
        onPin={(sessionId) => {
          // Target the pane that already holds the URL-focused mailbox, so the
          // pinned tab lands next to it. Falls back to the first non-empty
          // pane if no mailbox is mounted (e.g. user closed the layout's
          // mailbox tab earlier).
          const target =
            findPaneWithMailbox(layout) ?? findFirstNonEmptyPane(layout);
          if (target === null) return;
          dispatch({ kind: "pin_mailbox", pane: target.id, sessionId });
        }}
      />
    </div>
  );
}

function findPaneWithMailbox(node: LayoutNode): PaneNode | null {
  if (node.kind === "pane") {
    return node.views.some((v) => v.kind === "mailbox") ? node : null;
  }
  for (const c of node.children) {
    const hit = findPaneWithMailbox(c);
    if (hit !== null) return hit;
  }
  return null;
}

function findFirstNonEmptyPane(node: LayoutNode): PaneNode | null {
  if (node.kind === "pane") return node.views.length > 0 ? node : null;
  for (const c of node.children) {
    const hit = findFirstNonEmptyPane(c);
    if (hit !== null) return hit;
  }
  return null;
}
