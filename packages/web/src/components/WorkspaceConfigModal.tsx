import { useState } from "react";
import { api, type SettingSource, type Workspace } from "../api.ts";

interface Props {
  readonly workspace: Workspace;
  readonly onClose: () => void;
  readonly onSaved: (updated: Workspace) => void;
}

// Workspace config surface. Each knob is its own section so future config
// rows slot in without restructuring the modal.
export function WorkspaceConfigModal({ workspace, onClose, onSaved }: Props) {
  const initial = new Set<SettingSource>(workspace.setting_sources);
  const [project, setProject] = useState(initial.has("project"));
  const [local, setLocal] = useState(initial.has("local"));
  const [wakePrompt, setWakePrompt] = useState(workspace.wake_prompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const sources: SettingSource[] = ["user"];
    if (project) sources.push("project");
    if (local) sources.push("local");
    const trimmed = wakePrompt.trim();
    if (trimmed.length === 0) {
      setError("wake prompt cannot be empty");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateWorkspaceConfig(workspace.id, {
        setting_sources: sources,
        wake_prompt: trimmed,
      });
      onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-[32rem] max-w-[90vw] bg-zinc-950 border border-zinc-700 rounded-md shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-800">
          <div className="text-sm font-semibold text-zinc-100">
            workspace settings
          </div>
          <div className="text-xs text-zinc-500 font-mono truncate">
            {workspace.name} · {workspace.repo_path}
          </div>
        </div>

        <div className="px-4 py-3 space-y-3">
          <div className="text-xs text-zinc-400 uppercase tracking-wide">
            claude setting sources
          </div>
          <label className="flex items-start gap-2 text-sm text-zinc-200 cursor-pointer">
            <input
              type="checkbox"
              checked
              disabled
              className="mt-0.5 accent-emerald-700"
            />
            <span>
              <span className="font-mono">user</span> &nbsp;
              <span className="text-zinc-500 text-xs">
                — your <code>~/.claude/</code> (always on)
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-zinc-200 cursor-pointer">
            <input
              type="checkbox"
              checked={project}
              onChange={(e) => setProject(e.target.checked)}
              className="mt-0.5 accent-emerald-700"
            />
            <span>
              <span className="font-mono">project</span> &nbsp;
              <span className="text-zinc-500 text-xs">
                — the repo's <code>.claude/</code> (skills, commands, hooks)
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-zinc-200 cursor-pointer">
            <input
              type="checkbox"
              checked={local}
              onChange={(e) => setLocal(e.target.checked)}
              className="mt-0.5 accent-emerald-700"
            />
            <span>
              <span className="font-mono">local</span> &nbsp;
              <span className="text-zinc-500 text-xs">
                — the repo's <code>.claude.local/</code> (machine-specific)
              </span>
            </span>
          </label>
        </div>

        <div className="px-4 py-3 border-t border-zinc-800 space-y-2">
          <div className="text-xs text-zinc-400 uppercase tracking-wide">
            wake prompt
          </div>
          <div className="text-xs text-zinc-500">
            What a persistent agent is told when you tap the wake button without
            a specific task.
          </div>
          <textarea
            value={wakePrompt}
            onChange={(e) => setWakePrompt(e.target.value)}
            rows={4}
            className="w-full text-sm font-mono bg-zinc-900 border border-zinc-800 rounded p-2 text-zinc-100"
          />
        </div>

        {error !== null && (
          <div className="px-4 py-2 text-xs text-red-400 font-mono break-all">
            {error}
          </div>
        )}

        <div className="px-4 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-xs"
          >
            {busy ? "saving…" : "save"}
          </button>
        </div>
      </div>
    </div>
  );
}
