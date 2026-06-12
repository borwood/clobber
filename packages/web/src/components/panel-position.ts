const MARGIN = 8;

export interface PanelPosition {
  readonly top: number;
  readonly left: number;
  readonly placement: "above" | "below";
}

export function computePanelPosition(
  triggerRect: DOMRect,
  panelHeight: number,
  panelWidth: number,
  viewportHeight: number,
  viewportWidth: number,
): PanelPosition {
  const spaceBelow = viewportHeight - triggerRect.bottom;
  const placement = spaceBelow >= panelHeight + MARGIN ? "below" : "above";
  let top =
    placement === "below"
      ? triggerRect.bottom + MARGIN
      : triggerRect.top - panelHeight - MARGIN;
  top = Math.max(MARGIN, Math.min(top, viewportHeight - panelHeight - MARGIN));
  // Align left edge with trigger, clamped so panel never exits the viewport.
  let left = triggerRect.left;
  left = Math.max(MARGIN, Math.min(left, viewportWidth - panelWidth - MARGIN));
  return { top, left, placement };
}
