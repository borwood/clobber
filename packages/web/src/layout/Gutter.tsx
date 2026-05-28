import { useRef } from "react";
import { useLayout } from "./provider.tsx";
import { usePointerDrag } from "./usePointerDrag.ts";
import type { SplitNode } from "./types.ts";

interface Props {
  readonly splitPath: readonly number[];
  readonly sizes: SplitNode["sizes"];
  readonly index: number;          // boundary between child `index` and `index+1`
  readonly direction: SplitNode["direction"];
  readonly containerPx: number;
  readonly disabled?: boolean;
}

// 4px hit-target; ring on hover/active for cursor affordance (epic plan §6.8).
const HORIZONTAL_CLASS =
  "w-1 cursor-col-resize bg-zinc-800 hover:bg-zinc-600 active:bg-zinc-500";
const VERTICAL_CLASS =
  "h-1 cursor-row-resize bg-zinc-800 hover:bg-zinc-600 active:bg-zinc-500";

export function Gutter(props: Props) {
  const { splitPath, sizes, index, direction, containerPx, disabled } = props;
  const { dispatch } = useLayout();
  const baselineRef = useRef<readonly number[]>(sizes);

  const drag = usePointerDrag({
    disabled,
    onMove: (dx, dy) => {
      const delta = direction === "h" ? dx : dy;
      if (containerPx <= 0) return;
      const frac = delta / containerPx;
      const baseline = baselineRef.current;
      const next = baseline.slice();
      next[index] = (baseline[index] ?? 0) + frac;
      next[index + 1] = (baseline[index + 1] ?? 0) - frac;
      dispatch({ kind: "resize", splitPath, sizes: next, containerPx });
    },
  });

  return (
    <div
      data-gutter="true"
      role="separator"
      aria-orientation={direction === "h" ? "vertical" : "horizontal"}
      className={direction === "h" ? HORIZONTAL_CLASS : VERTICAL_CLASS}
      onPointerDown={(e) => {
        baselineRef.current = sizes;
        drag.onPointerDown(e);
      }}
    />
  );
}
