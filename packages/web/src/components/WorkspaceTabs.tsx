import { useState, type MouseEvent } from "react";
import { slugify, type Workspace } from "@clobber/shared";
import { buildPath } from "../router.ts";
import { Tabs } from "../layout/Tabs.tsx";
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
// (#243) — so `/` with nothing live is never a dead-end. The visible tabs are
// rendered through the shared <Tabs> primitive in its `workspace` variant
// (anchor strip with native middle/cmd-click). The `+` button and dropdown
// menu items remain bespoke — they aren't tabs.
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
  const slugById = new Map(workspaces.map((w) => [w.id, slugify(w.name)]));
  const visibleTabs = visible.map((w) => ({ id: w.id, label: w.name }));

  function navigateToSlug(slug: string): void {
    onSelect(slug);
    setMenuOpen(false);
  }

  function navigateMenu(e: MouseEvent<HTMLAnchorElement>, slug: string): void {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigateToSlug(slug);
  }

  return (
    <div className="flex items-center gap-1 relative">
      <Tabs
        as="a"
        variant="workspace"
        ariaLabel="workspaces"
        tabs={visibleTabs}
        activeId={selectedId}
        hrefFor={(id) => buildPath(slugById.get(id)!, null)}
        onNavigate={(id) => navigateToSlug(slugById.get(id)!)}
      />

      <button
        type="button"
        aria-label="Open workspace menu"
        onClick={() => {
          setMenuOpen((open) => !open);
          setCreating(false);
        }}
        className="px-2 py-1 rounded text-sm text-text-muted hover:text-text-dim border border-border hover:border-border-strong"
      >
        +
      </button>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
          <div
            role="menu"
            className="absolute top-full left-0 mt-1 z-20 w-64 bg-bg border border-border rounded shadow-xl flex flex-col"
          >
            <div className="max-h-72 overflow-y-auto py-1">
              {workspaces.map((w) => {
                const slug = slugById.get(w.id)!;
                return (
                  <a
                    key={w.id}
                    href={buildPath(slug, null)}
                    onClick={(e) => navigateMenu(e, slug)}
                    className={`block px-3 py-1.5 text-sm font-mono hover:bg-elevated focus-visible:outline focus-visible:outline-1 focus-visible:outline-text-subtle ${
                      w.id === selectedId ? "text-text" : "text-text-soft"
                    }`}
                  >
                    {w.name}
                  </a>
                );
              })}
            </div>
            <div className="border-t border-border p-2 sticky bottom-0 bg-bg">
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
                  className="w-full text-left px-1 py-1 text-sm text-accent-text hover:text-accent-text"
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
