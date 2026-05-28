import { useState, type MouseEvent } from "react";
import { slugify, type Workspace } from "@clobber/shared";
import { buildPath } from "../router.ts";
import { WorkspaceCreateForm } from "./WorkspaceCreateForm.tsx";

interface Props {
  readonly workspaces: readonly Workspace[];
  // Workspace ids with ≥1 live session (`ended_at IS NULL`).
  readonly liveWorkspaceIds: ReadonlySet<string>;
  readonly selectedId: string | null;
  readonly onSelect: (slug: string) => void;
  readonly onCreated: (ws: Workspace) => void;
}

// A workspace earns a *tab* when it has a live session OR is the one the URL
// currently points at. The rest are reachable through the `[+]` dropdown, which
// lists every workspace and carries the create form as its sticky bottom item
// (#243) — so `/` with nothing live is never a dead-end. Modified clicks
// (middle/cmd/ctrl) and right-click fall through to the native anchor so the
// browser opens the workspace in a new window/tab on the right URL.
export function WorkspaceTabs({
  workspaces,
  liveWorkspaceIds,
  selectedId,
  onSelect,
  onCreated,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const visible = workspaces.filter(
    (w) => liveWorkspaceIds.has(w.id) || w.id === selectedId,
  );

  function navigateTo(e: MouseEvent<HTMLAnchorElement>, slug: string): void {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onSelect(slug);
    setMenuOpen(false);
  }

  return (
    <div className="flex items-center gap-1 relative">
      {visible.map((w) => {
        const active = w.id === selectedId;
        const slug = slugify(w.name);
        return (
          <a
            key={w.id}
            href={buildPath(slug, null)}
            aria-current={active ? "page" : undefined}
            onClick={(e) => navigateTo(e, slug)}
            className={`px-3 py-1 rounded-t text-sm font-mono border-b-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-500 ${
              active
                ? "text-zinc-100 border-emerald-500"
                : "text-zinc-400 border-transparent hover:text-zinc-200 hover:border-zinc-700"
            }`}
          >
            {w.name}
          </a>
        );
      })}

      <button
        type="button"
        aria-label="Open workspace menu"
        onClick={() => {
          setMenuOpen((open) => !open);
          setCreating(false);
        }}
        className="px-2 py-1 rounded text-sm text-zinc-400 hover:text-zinc-200 border border-zinc-800 hover:border-zinc-700"
      >
        +
      </button>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
          <div
            role="menu"
            className="absolute top-full left-0 mt-1 z-20 w-64 bg-zinc-950 border border-zinc-800 rounded shadow-xl flex flex-col"
          >
            <div className="max-h-72 overflow-y-auto py-1">
              {workspaces.map((w) => {
                const slug = slugify(w.name);
                return (
                  <a
                    key={w.id}
                    href={buildPath(slug, null)}
                    onClick={(e) => navigateTo(e, slug)}
                    className={`block px-3 py-1.5 text-sm font-mono hover:bg-zinc-800 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-500 ${
                      w.id === selectedId ? "text-zinc-100" : "text-zinc-300"
                    }`}
                  >
                    {w.name}
                  </a>
                );
              })}
            </div>
            <div className="border-t border-zinc-800 p-2 sticky bottom-0 bg-zinc-950">
              {creating ? (
                <WorkspaceCreateForm
                  onCreated={(ws) => {
                    setCreating(false);
                    setMenuOpen(false);
                    onCreated(ws);
                  }}
                  onCancel={() => setCreating(false)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="w-full text-left px-1 py-1 text-sm text-emerald-400 hover:text-emerald-300"
                >
                  + new workspace…
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
