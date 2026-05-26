import { useState, type MouseEvent } from "react";
import { api, type Workspace } from "../api.ts";
import { buildPath } from "../router.ts";
import { FolderPicker } from "./FolderPicker.tsx";

interface Props {
  readonly workspaces: readonly Workspace[];
  // Workspace ids with ≥1 live session (`ended_at IS NULL`).
  readonly liveWorkspaceIds: ReadonlySet<string>;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onCreated: (ws: Workspace) => void;
}

// A workspace earns a tab when it has a live session OR is the one the URL
// currently points at. Modified clicks (middle/cmd/ctrl) and right-click fall
// through to the native anchor so the browser opens the workspace in a new
// window/tab on the right URL.
export function WorkspaceTabs({
  workspaces,
  liveWorkspaceIds,
  selectedId,
  onSelect,
  onCreated,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const visible = workspaces.filter(
    (w) => liveWorkspaceIds.has(w.id) || w.id === selectedId,
  );

  async function submit() {
    if (name.trim().length === 0 || repoPath.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createWorkspace({ name, repo_path: repoPath });
      onCreated(created);
      setName("");
      setRepoPath("");
      setCreating(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function handleTabClick(e: MouseEvent<HTMLAnchorElement>, id: string): void {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onSelect(id);
  }

  return (
    <div className="flex items-center gap-1">
      {visible.map((w) => {
        const active = w.id === selectedId;
        return (
          <a
            key={w.id}
            href={buildPath(w.id, null)}
            aria-current={active ? "page" : undefined}
            onClick={(e) => handleTabClick(e, w.id)}
            className={`px-3 py-1 rounded-t text-sm font-mono border-b-2 ${
              active
                ? "text-zinc-100 border-emerald-500"
                : "text-zinc-400 border-transparent hover:text-zinc-200 hover:border-zinc-700"
            }`}
          >
            {w.name}
          </a>
        );
      })}

      {creating ? (
        <div className="flex items-center gap-1 relative">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name"
            className="px-2 py-1 w-24 bg-zinc-900 border border-zinc-800 rounded text-xs focus:outline-none focus:border-zinc-600"
          />
          <input
            type="text"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="/repo/path"
            className="px-2 py-1 w-40 bg-zinc-900 border border-zinc-800 rounded text-xs font-mono focus:outline-none focus:border-zinc-600"
          />
          <button
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
            className="px-2 py-1 rounded text-xs text-zinc-300 hover:text-zinc-100 border border-zinc-800 hover:border-zinc-600"
            title="Browse for a folder"
          >
            browse…
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || name.trim().length === 0 || repoPath.trim().length === 0}
            className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-xs"
          >
            {busy ? "…" : "create"}
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating(false);
              setPickerOpen(false);
              setError(null);
            }}
            className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200"
          >
            cancel
          </button>
          {pickerOpen && (
            <FolderPicker
              {...(repoPath.trim().length > 0 ? { initialPath: repoPath } : {})}
              onSelect={(absolutePath) => {
                setRepoPath(absolutePath);
                setPickerOpen(false);
              }}
              onCancel={() => setPickerOpen(false)}
            />
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-800 hover:border-zinc-700"
        >
          + new
        </button>
      )}

      {error !== null && (
        <span className="text-xs text-red-400 font-mono break-all">{error}</span>
      )}
    </div>
  );
}
