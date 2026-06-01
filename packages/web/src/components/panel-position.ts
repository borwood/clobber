const MARGIN = 4;

export interface PanelPosition {
  readonly top: number;
  readonly right: number;
  readonly placement: "above" | "below";
}

export function computePanelPosition(
  triggerRect: DOMRect,
  panelHeight: number,
  viewportHeight: number,
  viewportWidth: number,
): PanelPosition {
  const spaceBelow = viewportHeight - triggerRect.bottom;
  const placement = spaceBelow >= panelHeight + MARGIN ? "below" : "above";
  let top =
    placement === "below"
      ? triggerRect.bottom + MARGIN
      : triggerRect.top - panelHeight - MARGIN;
  // Clamp so panel never goes off-screen (top or bottom).
  top = Math.max(MARGIN, Math.min(top, viewportHeight - panelHeight - MARGIN));
  const right = viewportWidth - triggerRect.right;
  return { top, right, placement };
}
