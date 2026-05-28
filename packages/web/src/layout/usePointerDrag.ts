import { useCallback, useEffect, useRef } from "react";

// Shared pointer-capture mechanism. <Gutter> uses it for split resize;
// <Pane> uses it for tab drag (#280). Generic on purpose — do not bake
// consumer-specific math into here. onStart may return `false` to abort
// (e.g. pointer-down happened on a non-tab element inside the captured area).
//
// `threshold` (px) defers onStart + e.preventDefault() until the pointer has
// moved at least that far. Tab strips need this so a plain click reaches the
// underlying <button onClick> (select_tab) instead of being interpreted as a
// zero-distance drag. Gutters omit threshold — no clickable child under them.
export interface PointerDragHandlers {
  readonly onStart?: (e: React.PointerEvent) => boolean | void;
  readonly onMove: (dx: number, dy: number, e: PointerEvent) => void;
  readonly onEnd?: (dx: number, dy: number, e: PointerEvent) => void;
}

export interface PointerDragOptions extends PointerDragHandlers {
  readonly disabled?: boolean | undefined;
  readonly threshold?: number | undefined;
}

export interface PointerDragApi {
  readonly onPointerDown: (e: React.PointerEvent) => void;
  readonly active: boolean;
}

export function usePointerDrag(opts: PointerDragOptions): PointerDragApi {
  const handlersRef = useRef<PointerDragHandlers>(opts);
  handlersRef.current = opts;
  const thresholdRef = useRef<number>(opts.threshold ?? 0);
  thresholdRef.current = opts.threshold ?? 0;

  const startRef = useRef<{ x: number; y: number; e: React.PointerEvent } | null>(null);
  const armedRef = useRef(false);
  const activeRef = useRef(false);

  const cleanup = useCallback(() => {
    if (!armedRef.current) return;
    armedRef.current = false;
    activeRef.current = false;
    startRef.current = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  }, []);

  function onMove(e: PointerEvent) {
    const start = startRef.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!activeRef.current) {
      const threshold = thresholdRef.current;
      if (Math.hypot(dx, dy) < threshold) return;
      if (handlersRef.current.onStart?.(start.e) === false) {
        cleanup();
        return;
      }
      activeRef.current = true;
      start.e.preventDefault();
    }
    handlersRef.current.onMove(dx, dy, e);
  }

  function onUp(e: PointerEvent) {
    const start = startRef.current;
    const dx = start ? e.clientX - start.x : 0;
    const dy = start ? e.clientY - start.y : 0;
    if (activeRef.current) {
      handlersRef.current.onEnd?.(dx, dy, e);
    }
    cleanup();
  }

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (opts.disabled) return;
      const threshold = thresholdRef.current;
      if (threshold === 0) {
        if (handlersRef.current.onStart?.(e) === false) return;
        e.preventDefault();
        activeRef.current = true;
      }
      startRef.current = { x: e.clientX, y: e.clientY, e };
      armedRef.current = true;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [opts.disabled],
  );

  useEffect(() => cleanup, [cleanup]);

  return { onPointerDown, active: activeRef.current };
}
