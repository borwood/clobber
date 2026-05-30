import React, { useRef, useState } from "react";
import type { PaneNode } from "./types.ts";
import { Tabs } from "./Tabs.tsx";
import { ViewHost, viewLabel } from "./ViewHost.tsx";
import { useLayout } from "./provider.tsx";
import { useWorkspace } from "./WorkspaceContext.tsx";
import { usePointerDrag } from "./usePointerDrag.ts";
import { PaneDropZones } from "./PaneDropZones.tsx";
import { computeDropIndex, edgeFromEvent, paneIdFromEvent } from "./drop-target.ts";
import { PaneIdProvider } from "./PaneIdContext.tsx";
import { EmptyRootPanePlaceholder } from "./EmptyRootPanePlaceholder.tsx";
import { EmptyPaneContextMenu } from "./EmptyPaneContextMenu.tsx";

const PANE_CLASS =
  "relative flex flex-col min-h-0 min-w-0 h-full w-full overflow-hidden";
const BODY_CLASS = "flex-1 min-h-0 overflow-hidden flex flex-col";

export function Pane(props: { readonly node: PaneNode }) {
  const { node } = props;
  const { dispatch, setTabDrag, tabDrag, layout } = useLayout();
  const { configOpen, sessions } = useWorkspace();
  const active = node.activeIndex === null ? null : node.views[node.activeIndex]!;

  // Refs survive across pointer events without re-rendering or being captured
  // stale by hook closures.
  const pendingIndexRef = useRef<number | null>(null);
  const activeIndexRef = useRef<number | null>(null);

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  function openMenu(e: React.MouseEvent) {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
  }

  const drag = usePointerDrag({
    disabled: configOpen,
    threshold: 4,
    onStart: (e) => {
      const idx = pendingIndexRef.current;
      pendingIndexRef.current = null;
      if (idx === null) return false;
      activeIndexRef.current = idx;
      setTabDrag({ kind: "move", fromPaneId: node.id, tabIndex: idx, x: e.clientX, y: e.clientY });
    },
    onMove: (_dx, _dy, e) => {
      const idx = activeIndexRef.current;
      if (idx === null) return;
      setTabDrag({ kind: "move", fromPaneId: node.id, tabIndex: idx, x: e.clientX, y: e.clientY });
    },
    onEnd: (_dx, _dy, e) => {
      const fromIndex = activeIndexRef.current;
      activeIndexRef.current = null;
      setTabDrag(null);
      if (fromIndex === null) return;
      const toPaneId = paneIdFromEvent(e);
      if (toPaneId === null) return;
      const edge = edgeFromEvent(e);
      if (edge === "top" || edge === "bottom" || edge === "left" || edge === "right") {
        dispatch({
          kind: "split_pane",
          pane: toPaneId,
          direction: edge === "top" || edge === "bottom" ? "v" : "h",
          before: edge === "top" || edge === "left",
          tab: { from: node.id, index: fromIndex },
        });
        return;
      }
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
    label: viewLabel(v, sessions),
    closable: true,
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
          onClose={(i) => dispatch({ kind: "close_tab", pane: node.id, index: i })}
          onTabPointerDown={
            configOpen
              ? undefined
              : (i, e) => {
                  pendingIndexRef.current = i;
                  drag.onPointerDown(e);
                }
          }
          ariaLabel={`pane ${node.id}`}
          trailing={
            <>
              <SplitButton
                label="Split right"
                onClick={() =>
                  dispatch({
                    kind: "split_pane",
                    pane: node.id,
                    direction: "h",
                    before: false,
                  })
                }
              >
                <span aria-hidden="true" className="inline-block w-3 h-3 border border-current border-l-2" />
              </SplitButton>
              <SplitButton
                label="Split down"
                onClick={() =>
                  dispatch({
                    kind: "split_pane",
                    pane: node.id,
                    direction: "v",
                    before: false,
                  })
                }
              >
                <span aria-hidden="true" className="inline-block w-3 h-3 border border-current border-t-2" />
              </SplitButton>
            </>
          }
        />
      )}
      <div className={BODY_CLASS}>
        <PaneIdProvider value={node.id}>
          {active === null ? (
            layout.kind === "pane" ? (
              <div className="flex-1 flex flex-col" onContextMenu={openMenu}>
                <EmptyRootPanePlaceholder paneId={node.id} />
              </div>
            ) : (
              <div
                className="relative flex-1 flex items-center justify-center text-xs text-text-faint"
                onContextMenu={openMenu}
              >
                drop a tab here
                <span
                  role="button"
                  aria-label="Close pane"
                  title="Close pane"
                  data-pane-close="true"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dispatch({ kind: "close_pane", pane: node.id });
                  }}
                  className="absolute top-2 right-2 w-5 h-5 inline-flex items-center justify-center rounded text-text-subtle hover:text-text hover:bg-raised cursor-pointer"
                >
                  ×
                </span>
              </div>
            )
          ) : (
            <ViewHost view={active} />
          )}
        </PaneIdProvider>
      </div>
      {tabDrag !== null && (
        <PaneDropZones paneId={node.id} hasTabs={tabs.length > 0} />
      )}
      {menuPos !== null && (
        <EmptyPaneContextMenu
          paneId={node.id}
          x={menuPos.x}
          y={menuPos.y}
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
  );
}

function SplitButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        props.onClick();
      }}
      className="px-2 inline-flex items-center text-text-subtle hover:text-text hover:bg-surface focus-visible:outline focus-visible:outline-1 focus-visible:outline-text-subtle"
    >
      {props.children}
    </button>
  );
}
