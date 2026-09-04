import { useEffect, useRef, useState, type ReactNode } from "react";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { useLayout } from "./provider.tsx";
import { defaultLayout } from "./default-layout.ts";
import {
  listClosedPanes,
  listSavedLayouts,
  loadSavedLayout,
  saveSavedLayout,
  type ClosedPaneEntry,
} from "./persistence.ts";
import { layoutHasViewKind } from "./find.ts";
import { SINGLETON_VIEW_KINDS, viewLabel } from "./ViewHost.tsx";
import type { PaneNode, ViewId } from "./types.ts";

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

  function onReopenKind(kind: Exclude<ViewId["kind"], "mailbox">) {
    const pane: PaneNode = {
      kind: "pane",
      id: `pane-reopened-${kind}-${Date.now()}`,
      views: [{ kind } as ViewId],
      activeIndex: 0,
    };
    dispatch({ kind: "reopen_pane", pane });
    close();
  }

  // Every closed panel type (a singleton view kind currently absent from the
  // layout tree, transcripts/mailbox excepted — see SINGLETON_VIEW_KINDS)
  // must be reopenable from here (#691).
  const missingKinds = SINGLETON_VIEW_KINDS.filter((kind) => !layoutHasViewKind(layout, kind));

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
        className="px-2 py-1 rounded text-text-muted hover:text-text-dim border border-border hover:border-border-strong flex items-center focus-visible:outline focus-visible:outline-1 focus-visible:outline-text-subtle"
      >
        <SquaresFourIcon size={16} weight="bold" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Layout"
          className="absolute right-0 top-full mt-1 z-20 w-60 rounded border border-border bg-bg shadow-lg py-1 text-sm"
        >
          <MenuItem onClick={onAddPane}>Add pane</MenuItem>
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
                className="flex-1 min-w-0 bg-surface border border-border rounded px-2 py-1 text-text focus:outline-none focus:border-border-strong"
              />
              <button
                type="button"
                onClick={onSaveConfirm}
                className="px-2 py-1 rounded text-text-dim border border-border-strong hover:border-text-subtle"
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
          <Submenu
            label="Reopen panel"
            empty={missingKinds.length === 0 ? "(none)" : null}
          >
            {missingKinds.map((kind) => (
              <MenuItem key={kind} onClick={() => onReopenKind(kind)}>
                {viewLabel({ kind } as ViewId)}
              </MenuItem>
            ))}
          </Submenu>
          <div className="my-1 border-t border-border" />
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
      className="w-full text-left px-3 py-1.5 text-text-soft hover:bg-surface hover:text-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-text-subtle"
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
      <div className="text-text-subtle text-xs uppercase tracking-wider mb-1">
        {props.label}
      </div>
      {props.empty !== null ? (
        <div className="text-text-faint italic pl-2">{props.empty}</div>
      ) : (
        <div className="flex flex-col -mx-3">{props.children}</div>
      )}
    </div>
  );
}
