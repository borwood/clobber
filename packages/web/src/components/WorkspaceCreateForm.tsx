import { useRef, useState } from "react";
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
  const browseButtonRef = useRef<HTMLButtonElement>(null);

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
        className="px-2 py-1 bg-surface border border-border rounded text-xs focus:outline-none focus:border-border-strong"
      />
      <input
        type="text"
        value={repoPath}
        onChange={(e) => setRepoPath(e.target.value)}
        placeholder="/repo/path"
        className="px-2 py-1 bg-surface border border-border rounded text-xs font-mono focus:outline-none focus:border-border-strong"
      />
      <div className="flex items-center gap-1">
        <button
          ref={browseButtonRef}
          type="button"
          onClick={() => setPickerOpen((open) => !open)}
          className="px-2 py-1 rounded text-xs text-text-soft hover:text-text border border-border hover:border-border-strong"
          title="Browse for a folder"
        >
          browse…
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || name.trim().length === 0 || repoPath.trim().length === 0}
          className="px-2 py-1 rounded bg-accent-strong hover:bg-accent disabled:bg-elevated disabled:text-text-subtle text-xs"
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
          className="px-2 py-1 rounded text-xs text-text-muted hover:text-text-dim"
        >
          cancel
        </button>
      </div>
      {pickerOpen && browseButtonRef.current !== null && (
        <FolderPicker
          {...(repoPath.trim().length > 0 ? { initialPath: repoPath } : {})}
          triggerRect={browseButtonRef.current.getBoundingClientRect()}
          onSelect={(absolutePath) => {
            setRepoPath(absolutePath);
            setPickerOpen(false);
          }}
          onCancel={() => setPickerOpen(false)}
        />
      )}
      {error !== null && (
        <span className="text-xs text-danger-text font-mono break-all">{error}</span>
      )}
    </div>
  );
}
