export type DropEdge = "top" | "right" | "bottom" | "left" | "center";

// Overlay rendered inside <Pane> during an active tab drag. Five mutually-
// exclusive hover zones — center triggers move_tab, edges trigger split_pane.
// Uniform chrome across all edges (mirror-presentation discipline, #299).
const ZONE_BASE =
  "absolute pointer-events-auto transition-colors bg-transparent hover:bg-sky-500/30";

export function PaneDropZones() {
  return (
    <div
      data-drop-overlay="true"
      className="absolute inset-0 z-20"
      style={{ pointerEvents: "none" }}
    >
      <div
        data-drop-edge="top"
        className={ZONE_BASE}
        style={{ top: 0, left: 0, right: 0, height: "25%" }}
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
