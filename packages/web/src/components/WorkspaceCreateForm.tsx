import { useState } from "react";
import { api, type Workspace } from "../api.ts";
import { FolderPicker } from "./FolderPicker.tsx";

interface Props {
  readonly onCreated: (ws: Workspace) => void;
  readonly onCancel: () => void;
}

// The create-workspace form. Lives as the sticky bottom item of the workspace
// dropdown (#243) — the server rejects a name whose slug collides, and that
// 409's message surfaces here.
export function WorkspaceCreateForm({ onCreated, onCancel }: Props) {
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  async function submit() {
    if (name.trim().length === 0 || repoPath.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createWorkspace({ name, repo_path: repoPath });
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 relative">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="name"
        className="px-2 py-1 bg-zinc-900 border border-zinc-800 rounded text-xs focus:outline-none focus:border-zinc-600"
      />
      <input
        type="text"
        value={repoPath}
        onChange={(e) => setRepoPath(e.target.value)}
        placeholder="/repo/path"
        className="px-2 py-1 bg-zinc-900 border border-zinc-800 rounded text-xs font-mono focus:outline-none focus:border-zinc-600"
      />
      <div className="flex items-center gap-1">
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
            setPickerOpen(false);
            setError(null);
            onCancel();
          }}
          className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200"
        >
          cancel
        </button>
      </div>
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
      {error !== null && (
        <span className="text-xs text-red-400 font-mono break-all">{error}</span>
      )}
    </div>
  );
}
