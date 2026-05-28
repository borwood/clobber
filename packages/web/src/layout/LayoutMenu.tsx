import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLayout } from "./provider.tsx";
import { defaultLayout } from "./default-layout.ts";
import {
  listClosedPanes,
  listSavedLayouts,
  loadSavedLayout,
  saveSavedLayout,
  type ClosedPaneEntry,
} from "./persistence.ts";
import type { LayoutNode, PaneNode } from "./types.ts";

function firstPaneId(node: LayoutNode): string | null {
  if (node.kind === "pane") return node.id;
  for (const c of node.children) {
    const hit = firstPaneId(c);
    if (hit !== null) return hit;
  }
  return null;
}

export function LayoutMenu() {
  const { workspaceSlug, layout, dispatch } = useLayout();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [savedNames, setSavedNames] = useState<readonly string[]>([]);
  const [closedEntries, setClosedEntries] = useState<readonly ClosedPaneEntry[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || workspaceSlug === null) return;
    setSavedNames(listSavedLayouts(workspaceSlug));
    setClosedEntries(listClosedPanes(workspaceSlug));
  }, [open, workspaceSlug, layout]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setRenaming(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setRenaming(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setRenaming(false);
  }

  function onAddPane() {
    dispatch({ kind: "add_pane" });
    close();
  }

  function onSplitVertical() {
    const id = firstPaneId(layout);
    if (id === null) return;
    dispatch({
      kind: "split_pane",
      pane: id,
      direction: "v",
      before: false,
      tab: { from: id, index: 0 },
    });
    close();
  }

  function onSaveConfirm() {
    const name = draftName.trim();
    if (name.length === 0 || workspaceSlug === null) return;
    saveSavedLayout(workspaceSlug, name, layout);
    setDraftName("");
    close();
  }

  function onLoad(name: string) {
    if (workspaceSlug === null) return;
    const tree = loadSavedLayout(workspaceSlug, name);
    if (tree === null) return;
    dispatch({ kind: "load_layout", tree });
    close();
  }

  function onReopen(entry: ClosedPaneEntry) {
    const pane: PaneNode = { ...entry.pane, id: `pane-reopened-${Date.now()}` };
    dispatch({ kind: "reopen_pane", pane });
    close();
  }

  function onReset() {
    const isDefault = JSON.stringify(layout) === JSON.stringify(defaultLayout());
    if (
      !isDefault &&
      !confirm("Reset layout? Your current arrangement will be lost.")
    ) {
      return;
    }
    dispatch({ kind: "reset" });
    close();
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Layout menu"
        title="Layout"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="px-2 py-1 rounded text-zinc-400 hover:text-zinc-200 border border-zinc-800 hover:border-zinc-700 text-sm leading-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-500"
      >
        ▦
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Layout"
          className="absolute right-0 top-full mt-1 z-20 w-60 rounded border border-zinc-800 bg-zinc-950 shadow-lg py-1 text-sm"
        >
          <MenuItem onClick={onAddPane}>Add pane</MenuItem>
          <MenuItem onClick={onSplitVertical}>Split current pane vertically</MenuItem>
          {renaming ? (
            <div className="px-3 py-1.5 flex items-center gap-2">
              <input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSaveConfirm();
                }}
                placeholder="Name"
                className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-100 focus:outline-none focus:border-zinc-600"
              />
              <button
                type="button"
                onClick={onSaveConfirm}
                className="px-2 py-1 rounded text-zinc-200 border border-zinc-700 hover:border-zinc-500"
              >
                Save
              </button>
            </div>
          ) : (
            <MenuItem onClick={() => setRenaming(true)}>Save layout…</MenuItem>
          )}
          <Submenu label="Saved layouts" empty={savedNames.length === 0 ? "(none)" : null}>
            {savedNames.map((n) => (
              <MenuItem key={n} onClick={() => onLoad(n)}>
                {n}
              </MenuItem>
            ))}
          </Submenu>
          <Submenu
            label="Re-open closed pane"
            empty={closedEntries.length === 0 ? "(none)" : null}
          >
            {closedEntries.map((e, i) => (
              <MenuItem key={i} onClick={() => onReopen(e)}>
                {e.label}
              </MenuItem>
            ))}
          </Submenu>
          <div className="my-1 border-t border-zinc-800" />
          <MenuItem onClick={onReset}>Reset layout</MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem(props: { readonly onClick: () => void; readonly children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={props.onClick}
      className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-500"
    >
      {props.children}
    </button>
  );
}

function Submenu(props: {
  readonly label: string;
  readonly empty: string | null;
  readonly children: ReactNode;
}) {
  return (
    <div className="px-3 py-1.5">
      <div className="text-zinc-500 text-xs uppercase tracking-wider mb-1">
        {props.label}
      </div>
      {props.empty !== null ? (
        <div className="text-zinc-600 italic pl-2">{props.empty}</div>
      ) : (
        <div className="flex flex-col -mx-3">{props.children}</div>
      )}
    </div>
  );
}
