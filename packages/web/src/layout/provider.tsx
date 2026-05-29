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
import { loadLayout, pushClosedPane, saveLayout } from "./persistence.ts";
import { closedRingCaptureFor } from "./closed-ring-capture.ts";
import { useLayoutEvents } from "./useLayoutEvents.ts";
import { viewLabel } from "./ViewHost.tsx";
import { computeDropIndex, edgeFromEvent, paneIdFromEvent } from "./drop-target.ts";

// Pending drop covers two cursor-following modes that both render through
// <PaneDropZones>: a tab being dragged between panes (move) and a session
// being placed via the SessionList right-click menu (insert, #316).
export type PendingDrop =
  | {
      readonly kind: "move";
      readonly fromPaneId: string;
      readonly tabIndex: number;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly kind: "insert";
      readonly view: ViewId;
      readonly x: number;
      readonly y: number;
    };

interface LayoutContextValue {
  readonly workspaceSlug: string | null;
  readonly layout: LayoutNode;
  readonly dispatch: (a: Action) => void;
  readonly focusView: (kind: ViewId["kind"]) => void;
  readonly tabDrag: PendingDrop | null;
  readonly setTabDrag: (state: PendingDrop | null) => void;
}

const Ctx = createContext<LayoutContextValue | null>(null);

interface Props {
  readonly workspaceSlug: string | null;
  // Workspace id keys the server→web layout-event poll (#326); the slug keys
  // localStorage. Both are needed because the provider sits above WorkspaceContext.
  readonly workspaceId: string | null;
  readonly deepLinkSessionId: string | null;
  readonly children: ReactNode;
}

export function LayoutProvider({
  workspaceSlug,
  workspaceId,
  deepLinkSessionId,
  children,
}: Props) {
  const [layout, rawDispatch] = useReducer(layoutReducer, workspaceSlug, init);
  const [tabDrag, setTabDrag] = useState<PendingDrop | null>(null);

  // Insert-mode (#316): the next click on any drop-zone within a pane lands
  // the pending view there. Escape (or a click outside the overlay) cancels.
  useEffect(() => {
    if (tabDrag === null || tabDrag.kind !== "insert") return;
    const pendingView = tabDrag.view;
    function onClick(e: MouseEvent) {
      const paneId = paneIdFromEvent(e);
      const edge = edgeFromEvent(e);
      setTabDrag(null);
      if (paneId === null || edge === null) return;
      if (edge === "center") {
        rawDispatch({ kind: "open_view", pane: paneId, view: pendingView });
        return;
      }
      if (edge === "tabs") {
        rawDispatch({
          kind: "open_view_at",
          pane: paneId,
          view: pendingView,
          index: computeDropIndex(paneId, e.clientX),
        });
        return;
      }
      rawDispatch({
        kind: "split_pane",
        pane: paneId,
        direction: edge === "top" || edge === "bottom" ? "v" : "h",
        before: edge === "top" || edge === "left",
        tab: { view: pendingView },
      });
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setTabDrag(null);
    }
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [tabDrag]);

  useEffect(() => {
    if (workspaceSlug === null) return;
    saveLayout(workspaceSlug, layout);
  }, [workspaceSlug, layout]);

  // Deep-link cold-load auto-pin (#309): when arriving with /s/:sid in the URL
  // and no tab for that session exists yet, pin one via the 4-step routing
  // rule. The root pane is used as the originating-pane proxy on cold load.
  useEffect(() => {
    if (deepLinkSessionId === null) return;
    if (hasMailboxFor(layout, deepLinkSessionId)) return;
    const root = firstPaneId(layout);
    if (root === null) return;
    rawDispatch({
      kind: "open_session_tab",
      sessionId: deepLinkSessionId,
      originatingPaneId: root,
    });
    // Run once per session-id change; auto-pinning depends on the URL, not on
    // subsequent layout edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkSessionId, workspaceSlug]);

  const dispatch = useCallback(
    (a: Action) => {
      if (workspaceSlug !== null) {
        const cap = closedRingCaptureFor(layout, a);
        if (cap !== null) {
          pushClosedPane(workspaceSlug, cap.pane, viewLabel(cap.view), Date.now());
        }
      }
      rawDispatch(a);
    },
    [layout, workspaceSlug],
  );

  // Server→web layout bridge (#326): a server-emitted layout event becomes a
  // local reducer dispatch, so a swap persists and renders like any local edit.
  useLayoutEvents(workspaceId, dispatch);

  // Whiteboard's wake handler used to flip the global view to mailbox; in the
  // new model, "focus a view" means selecting its tab in whichever pane
  // currently owns it.
  const focusView = useCallback((kind: ViewId["kind"]) => {
    const hit = findPaneWith(layout, kind);
    if (hit === null) return;
    dispatch({ kind: "select_tab", pane: hit.pane.id, index: hit.index });
  }, [layout]);

  return (
    <Ctx.Provider value={{ workspaceSlug, layout, dispatch, focusView, tabDrag, setTabDrag }}>
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

function hasMailboxFor(node: LayoutNode, sessionId: string): boolean {
  if (node.kind === "pane") {
    return node.views.some((v) => v.kind === "mailbox" && v.sessionId === sessionId);
  }
  return node.children.some((c) => hasMailboxFor(c, sessionId));
}

function firstPaneId(node: LayoutNode): string | null {
  if (node.kind === "pane") return node.id;
  for (const c of node.children) {
    const hit = firstPaneId(c);
    if (hit !== null) return hit;
  }
  return null;
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
