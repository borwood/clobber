import { describe, expect, it } from "bun:test";
import { computePanelPosition } from "../src/components/panel-position.ts";

function rect(top: number, bottom: number, left: number, right: number): DOMRect {
  return { top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

describe("computePanelPosition", () => {
  it("places panel below when there is room", () => {
    const r = rect(80, 100, 400, 600);
    const result = computePanelPosition(r, 200, 300, 800, 1200);
    expect(result.placement).toBe("below");
    expect(result.top).toBe(108); // bottom(100) + margin(8)
  });

  it("flips panel above when insufficient room below", () => {
    const r = rect(680, 700, 400, 600);
    const result = computePanelPosition(r, 200, 300, 800, 1200);
    expect(result.placement).toBe("above");
    expect(result.top).toBe(472); // top(680) - panelHeight(200) - margin(8)
  });

  it("aligns panel left edge with trigger left edge when room exists", () => {
    const r = rect(100, 120, 400, 600);
    const result = computePanelPosition(r, 100, 300, 800, 1200);
    expect(result.left).toBe(400);
  });

  it("clamps left so panel does not overflow right edge of viewport", () => {
    // trigger.left=1000, panelWidth=300, viewport=1200 → raw left=1000, max=1200-300-8=892 → clamped to 892
    const r = rect(100, 120, 1000, 1100);
    const result = computePanelPosition(r, 100, 300, 800, 1200);
    expect(result.left).toBe(892);
  });

  it("clamps left to MARGIN when trigger is near left edge", () => {
    // trigger.left=2, panelWidth=300 → raw left=2, min=8 → clamped to 8
    const r = rect(100, 120, 2, 80);
    const result = computePanelPosition(r, 100, 300, 800, 1200);
    expect(result.left).toBe(8);
  });

  it("boundary: exactly fits below (spaceBelow === panelHeight + margin)", () => {
    // spaceBelow = 800 - 592 = 208 = panelHeight(200) + MARGIN(8) → fits
    const r = rect(572, 592, 400, 600);
    const result = computePanelPosition(r, 200, 300, 800, 1200);
    expect(result.placement).toBe("below");
  });

  it("boundary: one pixel short of fitting below flips above", () => {
    // spaceBelow = 800 - 593 = 207 < 208 → flips
    const r = rect(573, 593, 400, 600);
    const result = computePanelPosition(r, 200, 300, 800, 1200);
    expect(result.placement).toBe("above");
  });

  it("clamps top to >= MARGIN when above-flip would go negative", () => {
    const r = rect(2, 22, 400, 600);
    const result = computePanelPosition(r, 200, 300, 800, 1200);
    expect(result.top).toBeGreaterThanOrEqual(8);
  });

  it("clamps top so panel bottom does not exceed viewport in below placement", () => {
    const r = rect(730, 750, 400, 600);
    const result = computePanelPosition(r, 200, 300, 800, 1200);
    expect(result.top + 200).toBeLessThanOrEqual(800 - 8);
  });
});
