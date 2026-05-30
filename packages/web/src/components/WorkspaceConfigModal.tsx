import { useState } from "react";
import { api, type SettingSource, type Workspace } from "../api.ts";
import {
  BUILT_IN_MODES,
  BUILT_IN_ACCENTS,
  type BuiltInMode,
  type BuiltInAccent,
} from "@clobber/shared";

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
  const [mode, setMode] = useState<BuiltInMode>(workspace.theme.mode);
  const [accent, setAccent] = useState<BuiltInAccent>(workspace.theme.accent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const sources: SettingSource[] = ["user"];
    if (project) sources.push("project");
    if (local) sources.push("local");
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateWorkspaceConfig(workspace.id, {
        setting_sources: sources,
        theme: { mode, accent },
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
        className="w-[32rem] max-w-[90vw] bg-bg border border-border-strong rounded-md shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border">
          <div className="text-sm font-semibold text-text">
            workspace settings
          </div>
          <div className="text-xs text-text-subtle font-mono truncate">
            {workspace.name} · {workspace.repo_path}
          </div>
        </div>

        <div className="px-4 py-3 space-y-3">
          <div className="text-xs text-text-muted uppercase tracking-wide">
            claude setting sources
          </div>
          <label className="flex items-start gap-2 text-sm text-text-dim cursor-pointer">
            <input
              type="checkbox"
              checked
              disabled
              className="mt-0.5 accent-accent-strong"
            />
            <span>
              <span className="font-mono">user</span> &nbsp;
              <span className="text-text-subtle text-xs">
                — your <code>~/.claude/</code> (always on)
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-text-dim cursor-pointer">
            <input
              type="checkbox"
              checked={project}
              onChange={(e) => setProject(e.target.checked)}
              className="mt-0.5 accent-accent-strong"
            />
            <span>
              <span className="font-mono">project</span> &nbsp;
              <span className="text-text-subtle text-xs">
                — the repo's <code>.claude/</code> (skills, commands, hooks)
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-text-dim cursor-pointer">
            <input
              type="checkbox"
              checked={local}
              onChange={(e) => setLocal(e.target.checked)}
              className="mt-0.5 accent-accent-strong"
            />
            <span>
              <span className="font-mono">local</span> &nbsp;
              <span className="text-text-subtle text-xs">
                — the repo's <code>.claude.local/</code> (machine-specific)
              </span>
            </span>
          </label>
        </div>

        <div className="px-4 py-3 border-t border-border space-y-3">
          <div className="text-xs text-text-muted uppercase tracking-wide">
            theme
          </div>

          <div className="space-y-1.5">
            <div className="text-xs text-text-subtle">mode</div>
            <div className="flex gap-2">
              {BUILT_IN_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  data-theme={m}
                  onClick={() => setMode(m)}
                  className={`flex-1 flex items-center gap-2 px-3 py-2 rounded border bg-bg ${
                    mode === m
                      ? "border-accent"
                      : "border-border hover:border-border-strong"
                  }`}
                >
                  <span className="h-4 w-4 rounded-sm bg-surface border border-border-strong" />
                  <span className="text-xs text-text-dim capitalize">{m}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="text-xs text-text-subtle">accent</div>
            <div className="flex gap-2">
              {BUILT_IN_ACCENTS.map((a) => (
                <button
                  key={a}
                  type="button"
                  data-accent={a}
                  onClick={() => setAccent(a)}
                  title={a}
                  aria-label={a}
                  className={`h-7 w-7 rounded-full bg-accent border-2 ${
                    accent === a ? "border-text" : "border-transparent"
                  }`}
                />
              ))}
            </div>
          </div>
        </div>

        {error !== null && (
          <div className="px-4 py-2 text-xs text-danger-text font-mono break-all">
            {error}
          </div>
        )}

        <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1 rounded text-xs text-text-muted hover:text-text-dim"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="px-3 py-1 rounded bg-accent-strong hover:bg-accent disabled:bg-elevated disabled:text-text-subtle text-xs"
          >
            {busy ? "saving…" : "save"}
          </button>
        </div>
      </div>
    </div>
  );
}
