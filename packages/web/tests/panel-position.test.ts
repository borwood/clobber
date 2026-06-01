import { describe, expect, it } from "bun:test";
import { computePanelPosition } from "../src/components/panel-position.ts";

function rect(top: number, bottom: number, left: number, right: number): DOMRect {
  return { top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

describe("computePanelPosition", () => {
  it("places panel below when there is room", () => {
    const r = rect(80, 100, 400, 600);
    const result = computePanelPosition(r, 200, 800, 1200);
    expect(result.placement).toBe("below");
    expect(result.top).toBe(104); // bottom(100) + margin(4)
  });

  it("flips panel above when insufficient room below", () => {
    const r = rect(680, 700, 400, 600);
    const result = computePanelPosition(r, 200, 800, 1200);
    expect(result.placement).toBe("above");
    expect(result.top).toBe(476); // top(680) - panelHeight(200) - margin(4)
  });

  it("computes right as distance from viewport right edge to trigger right", () => {
    const r = rect(100, 120, 900, 1000);
    const result = computePanelPosition(r, 100, 800, 1200);
    expect(result.right).toBe(200); // viewportWidth(1200) - triggerRight(1000)
  });

  it("boundary: exactly fits below (spaceBelow === panelHeight + margin)", () => {
    const r = rect(576, 596, 400, 600);
    const result = computePanelPosition(r, 200, 800, 1200);
    expect(result.placement).toBe("below");
  });

  it("boundary: one pixel short of fitting below flips above", () => {
    const r = rect(577, 597, 400, 600);
    const result = computePanelPosition(r, 200, 800, 1200);
    expect(result.placement).toBe("above");
  });

  it("clamps top to >= MARGIN when above-flip would go negative", () => {
    // trigger near top: top=2, panelHeight=200 → raw above top = 2 - 200 - 4 = -202 → clamped to 4
    const r = rect(2, 22, 400, 600);
    const result = computePanelPosition(r, 200, 800, 1200);
    expect(result.top).toBeGreaterThanOrEqual(4);
  });

  it("clamps top so panel bottom does not exceed viewport in below placement", () => {
    // trigger at bottom=750, panelHeight=200, viewport=800 → raw top=754, panel bottom=954 > 800
    // clamp: top = min(754, 800 - 200 - 4) = min(754, 596) = 596
    const r = rect(730, 750, 400, 600);
    const result = computePanelPosition(r, 200, 800, 1200);
    expect(result.top + 200).toBeLessThanOrEqual(800 - 4);
  });
});
