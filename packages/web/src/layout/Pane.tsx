import { useRef } from "react";
import type { PaneNode } from "./types.ts";
import { Tabs } from "./Tabs.tsx";
import { ViewHost, viewLabel } from "./ViewHost.tsx";
import { useLayout } from "./provider.tsx";
import { useWorkspace } from "./WorkspaceContext.tsx";
import { usePointerDrag } from "./usePointerDrag.ts";

const PANE_CLASS = "flex flex-col min-h-0 min-w-0 h-full w-full overflow-hidden";
const BODY_CLASS = "flex-1 min-h-0 overflow-hidden flex flex-col";

export function Pane(props: { readonly node: PaneNode }) {
  const { node } = props;
  const { dispatch, setTabDrag } = useLayout();
  const { configOpen } = useWorkspace();
  const active = node.activeIndex === null ? null : node.views[node.activeIndex]!;

  // Refs survive across pointer events without re-rendering or being captured
  // stale by hook closures.
  const pendingIndexRef = useRef<number | null>(null);
  const activeIndexRef = useRef<number | null>(null);

  const drag = usePointerDrag({
    disabled: configOpen,
    onStart: (e) => {
      const idx = pendingIndexRef.current;
      pendingIndexRef.current = null;
      if (idx === null) return false;
      activeIndexRef.current = idx;
      setTabDrag({ fromPaneId: node.id, tabIndex: idx, x: e.clientX, y: e.clientY });
    },
    onMove: (_dx, _dy, e) => {
      const idx = activeIndexRef.current;
      if (idx === null) return;
      setTabDrag({ fromPaneId: node.id, tabIndex: idx, x: e.clientX, y: e.clientY });
    },
    onEnd: (_dx, _dy, e) => {
      const fromIndex = activeIndexRef.current;
      activeIndexRef.current = null;
      setTabDrag(null);
      if (fromIndex === null) return;
      const toPaneId = paneIdFromEvent(e);
      if (toPaneId === null) return;
      dispatch({
        kind: "move_tab",
        from: node.id,
        to: toPaneId,
        tabIndex: fromIndex,
        dropIndex: computeDropIndex(toPaneId, e.clientX),
      });
    },
  });

  const tabs = node.views.map((v, i) => ({
    id: String(i),
    label: viewLabel(v),
  }));

  return (
    <div className={PANE_CLASS} data-pane="true" data-pane-id={node.id}>
      {tabs.length > 0 && (
        <Tabs
          tabs={tabs}
          activeId={node.activeIndex === null ? null : String(node.activeIndex)}
          onSelect={(id) =>
            dispatch({ kind: "select_tab", pane: node.id, index: Number(id) })
          }
          onTabPointerDown={
            configOpen
              ? undefined
              : (i, e) => {
                  pendingIndexRef.current = i;
                  drag.onPointerDown(e);
                }
          }
          ariaLabel={`pane ${node.id}`}
        />
      )}
      <div className={BODY_CLASS}>
        {active === null ? (
          <div className="flex-1 flex items-center justify-center text-xs text-zinc-600">
            drop a tab here
          </div>
        ) : (
          <ViewHost view={active} />
        )}
      </div>
    </div>
  );
}

function paneIdFromEvent(e: PointerEvent): string | null {
  const target = e.target;
  if (target instanceof Element) {
    const pane = target.closest<HTMLElement>('[data-pane="true"]');
    if (pane !== null) return pane.dataset.paneId ?? null;
  }
  if (typeof document === "undefined") return null;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  return el instanceof Element
    ? el.closest<HTMLElement>('[data-pane="true"]')?.dataset.paneId ?? null
    : null;
}

function computeDropIndex(paneId: string, clientX: number): number {
  if (typeof document === "undefined") return 0;
  const tabs = document.querySelectorAll<HTMLElement>(
    `[data-pane-id="${paneId}"] [role="tab"]`,
  );
  for (let i = 0; i < tabs.length; i++) {
    const r = tabs[i]!.getBoundingClientRect();
    if (clientX < r.left + r.width / 2) return i;
  }
  return tabs.length;
}
