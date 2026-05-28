import { useLayoutEffect, useRef, useState } from "react";
import { dropCaretX } from "./drop-target.ts";

export type DropEdge = "top" | "right" | "bottom" | "left" | "center" | "tabs";

// Overlay rendered inside <Pane> during an active tab drag. Six mutually-
// exclusive hover zones — center triggers move_tab, edges trigger split_pane,
// the tab strip triggers an insert/reorder at the cursor index.
// Uniform chrome across all zones (mirror-presentation discipline, #299).
const ZONE_BASE =
  "absolute pointer-events-auto transition-colors bg-transparent hover:bg-sky-500/30";

export function PaneDropZones(props: { readonly paneId: string; readonly hasTabs: boolean }) {
  const { paneId, hasTabs } = props;
  const overlayRef = useRef<HTMLDivElement>(null);
  const [tabBarPx, setTabBarPx] = useState(0);

  // The strip must match the live tab-bar height, not a guessed constant: read
  // the rendered tablist (sibling of this overlay) so an h-9→h-10 change in
  // Tabs can't desync the zone (#318).
  useLayoutEffect(() => {
    if (!hasTabs) return;
    const tablist = overlayRef.current!.parentElement!.querySelector<HTMLElement>(
      ':scope > [role="tablist"]',
    );
    if (tablist === null) return;
    setTabBarPx(tablist.getBoundingClientRect().height);
  }, [hasTabs]);

  return (
    <div
      ref={overlayRef}
      data-drop-overlay="true"
      className="absolute inset-0 z-20"
      style={{ pointerEvents: "none" }}
    >
      {hasTabs && <TabStripZone paneId={paneId} height={tabBarPx} />}
      <div
        data-drop-edge="top"
        className={ZONE_BASE}
        style={{ top: hasTabs ? tabBarPx : 0, bottom: "75%", left: 0, right: 0 }}
      />
      <div
        data-drop-edge="bottom"
        className={ZONE_BASE}
        style={{ bottom: 0, left: 0, right: 0, height: "25%" }}
      />
      <div
        data-drop-edge="left"
        className={ZONE_BASE}
        style={{ top: "25%", bottom: "25%", left: 0, width: "25%" }}
      />
      <div
        data-drop-edge="right"
        className={ZONE_BASE}
        style={{ top: "25%", bottom: "25%", right: 0, width: "25%" }}
      />
      <div
        data-drop-edge="center"
        className={ZONE_BASE}
        style={{ top: "25%", bottom: "25%", left: "25%", right: "25%" }}
      />
    </div>
  );
}

// Strip overlaying the pane's tab bar. Occludes the top-split zone within the
// tab-bar band only (top-split stays reachable just below). Tracks the cursor
// to render a 2px insertion caret at the same boundary a drop dispatches to.
function TabStripZone(props: { readonly paneId: string; readonly height: number }) {
  const { paneId, height } = props;
  const [caretX, setCaretX] = useState<number | null>(null);

  return (
    <div
      data-drop-edge="tabs"
      className={ZONE_BASE}
      style={{ top: 0, left: 0, right: 0, height }}
      onMouseMove={(e) => setCaretX(dropCaretX(paneId, e.clientX))}
      onMouseLeave={() => setCaretX(null)}
    >
      {caretX !== null && (
        <div
          data-tab-caret="true"
          className="absolute top-0 bottom-0 w-0.5 bg-sky-400 pointer-events-none"
          style={{ left: caretX }}
        />
      )}
    </div>
  );
}
