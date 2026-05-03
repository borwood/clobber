import { useState } from "react";
import { api, type Workspace } from "../api.ts";

interface Props {
  readonly workspaces: readonly Workspace[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onCreated: (ws: Workspace) => void;
}

export function WorkspaceSwitcher({ workspaces, selectedId, onSelect, onCreated }: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="flex items-center gap-2">
      <select
        value={selectedId ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        disabled={workspaces.length === 0}
        className="px-2 py-1 bg-zinc-900 border border-zinc-800 rounded text-sm font-mono text-zinc-200 focus:outline-none focus:border-zinc-600 disabled:opacity-50"
      >
        {workspaces.length === 0 && <option value="">— no workspaces —</option>}
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>

      {creating ? (
        <div className="flex items-center gap-1">
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
              setError(null);
            }}
            className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200"
          >
            cancel
          </button>
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
