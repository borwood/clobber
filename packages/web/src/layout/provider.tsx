import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useState,
  type ReactNode,
} from "react";
import { layoutReducer, type Action } from "./reducer.ts";
import type { LayoutNode, PaneNode, ViewId } from "./types.ts";
import { defaultLayout } from "./default-layout.ts";
import { loadLayout, saveLayout } from "./persistence.ts";

export interface TabDragState {
  readonly fromPaneId: string;
  readonly tabIndex: number;
  readonly x: number;
  readonly y: number;
}

interface LayoutContextValue {
  readonly layout: LayoutNode;
  readonly dispatch: (a: Action) => void;
  readonly focusView: (kind: ViewId["kind"]) => void;
  readonly tabDrag: TabDragState | null;
  readonly setTabDrag: (state: TabDragState | null) => void;
}

const Ctx = createContext<LayoutContextValue | null>(null);

interface Props {
  readonly workspaceSlug: string | null;
  readonly children: ReactNode;
}

export function LayoutProvider({ workspaceSlug, children }: Props) {
  const [layout, dispatch] = useReducer(layoutReducer, workspaceSlug, init);
  const [tabDrag, setTabDrag] = useState<TabDragState | null>(null);

  useEffect(() => {
    if (workspaceSlug === null) return;
    saveLayout(workspaceSlug, layout);
  }, [workspaceSlug, layout]);

  // Whiteboard's wake handler used to flip the global view to mailbox; in the
  // new model, "focus a view" means selecting its tab in whichever pane
  // currently owns it.
  const focusView = useCallback((kind: ViewId["kind"]) => {
    const hit = findPaneWith(layout, kind);
    if (hit === null) return;
    dispatch({ kind: "select_tab", pane: hit.pane.id, index: hit.index });
  }, [layout]);

  return (
    <Ctx.Provider value={{ layout, dispatch, focusView, tabDrag, setTabDrag }}>
      {children}
    </Ctx.Provider>
  );
}

function init(workspaceSlug: string | null): LayoutNode {
  if (workspaceSlug === null) return defaultLayout();
  if (typeof localStorage === "undefined") return defaultLayout();
  const stored = loadLayout(workspaceSlug);
  return stored ?? defaultLayout();
}

function findPaneWith(
  node: LayoutNode,
  kind: ViewId["kind"],
): { pane: PaneNode; index: number } | null {
  if (node.kind === "pane") {
    const idx = node.views.findIndex((v) => v.kind === kind);
    return idx === -1 ? null : { pane: node, index: idx };
  }
  for (const c of node.children) {
    const hit = findPaneWith(c, kind);
    if (hit !== null) return hit;
  }
  return null;
}

export function useLayout(): LayoutContextValue {
  const v = useContext(Ctx);
  if (v === null) throw new Error("useLayout outside LayoutProvider");
  return v;
}
