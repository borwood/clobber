import { useCallback, useEffect, useRef } from "react";

// Shared pointer-capture mechanism. Used in this step by <Gutter> for split
// resize; step 4 (#280) will reuse it for tab drag. Generic on purpose — do
// not bake gutter-specific math into here.
export interface PointerDragHandlers {
  readonly onMove: (dx: number, dy: number, e: PointerEvent) => void;
  readonly onEnd?: (dx: number, dy: number, e: PointerEvent) => void;
}

export interface PointerDragOptions extends PointerDragHandlers {
  readonly disabled?: boolean | undefined;
}

export interface PointerDragApi {
  readonly onPointerDown: (e: React.PointerEvent) => void;
  readonly active: boolean;
}

export function usePointerDrag(opts: PointerDragOptions): PointerDragApi {
  const handlersRef = useRef<PointerDragHandlers>(opts);
  handlersRef.current = opts;

  const startRef = useRef<{ x: number; y: number } | null>(null);
  const activeRef = useRef(false);

  const cleanup = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    startRef.current = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  }, []);

  function onMove(e: PointerEvent) {
    const start = startRef.current;
    if (!start) return;
    handlersRef.current.onMove(e.clientX - start.x, e.clientY - start.y, e);
  }

  function onUp(e: PointerEvent) {
    const start = startRef.current;
    const dx = start ? e.clientX - start.x : 0;
    const dy = start ? e.clientY - start.y : 0;
    handlersRef.current.onEnd?.(dx, dy, e);
    cleanup();
  }

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (opts.disabled) return;
      e.preventDefault();
      startRef.current = { x: e.clientX, y: e.clientY };
      activeRef.current = true;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [opts.disabled],
  );

  useEffect(() => cleanup, [cleanup]);

  return { onPointerDown, active: activeRef.current };
}
