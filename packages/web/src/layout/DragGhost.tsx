import { useLayout } from "./provider.tsx";
import { findPaneById } from "./find.ts";
import { TAB_ACTIVE_CLASS, TAB_BASE_CLASS } from "./Tabs.tsx";
import { viewLabel } from "./ViewHost.tsx";

// Floating tab follows the cursor while a tab drag is in progress. Mirrors
// the active-tab class grammar so the dragged thing visibly *is* the tab
// being moved (mirror-presentation discipline).
export function DragGhost() {
  const { layout, tabDrag } = useLayout();
  if (tabDrag === null) return null;
  const pane = findPaneById(layout, tabDrag.fromPaneId);
  const view = pane?.views[tabDrag.tabIndex];
  if (!view) return null;
  const style: React.CSSProperties = {
    position: "fixed",
    left: tabDrag.x + 8,
    top: tabDrag.y + 8,
    pointerEvents: "none",
    zIndex: 1000,
  };
  return (
    <div
      data-drag-ghost="true"
      style={style}
      className={`${TAB_BASE_CLASS} ${TAB_ACTIVE_CLASS} border border-zinc-700 shadow-lg`}
    >
      {viewLabel(view)}
    </div>
  );
}
