import { useState } from "react";
import { api, type EffortLevel, type SpawnResponse } from "../api.ts";

interface Props {
  readonly workspaceId: string;
  readonly roleId: string | null;
  readonly onSpawned: (s: SpawnResponse) => void;
}

type EffortChoice = EffortLevel | "default";

const EFFORT_CHOICES: readonly EffortChoice[] = [
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function SpawnPanel({ workspaceId, roleId, onSpawned }: Props) {
  const [prompt, setPrompt] = useState("");
  const [label, setLabel] = useState("");
  const [effort, setEffort] = useState<EffortChoice>("default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (roleId === null) return;
    if (prompt.trim().length === 0) return;
    const trimmedLabel = label.trim();
    if (trimmedLabel.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.spawn({
        workspace_id: workspaceId,
        role_id: roleId,
        prompt,
        label: trimmedLabel,
        ...(effort === "default" ? {} : { effort }),
      });
      onSpawned(res);
      setPrompt("");
      setLabel("");
      setEffort("default");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const disabled =
    roleId === null ||
    busy ||
    prompt.trim().length === 0 ||
    label.trim().length === 0;

  return (
    <div className="space-y-3">
      <h2 className="text-sm uppercase tracking-wider text-zinc-500">spawn</h2>

      <label className="block">
        <span className="block text-xs text-zinc-400 mb-1">label</span>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. fix-flaky-test"
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-sm focus:outline-none focus:border-zinc-600"
        />
      </label>

      <label className="block">
        <span className="block text-xs text-zinc-400 mb-1">prompt</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-sm focus:outline-none focus:border-zinc-600"
          placeholder={
            roleId === null
              ? "select a role above first…"
              : "Run the bash command `echo hello`…"
          }
          disabled={roleId === null}
        />
      </label>

      <label className="block">
        <span className="block text-xs text-zinc-400 mb-1">
          effort{" "}
          <span className="text-zinc-600">
            (default = role's reasoning depth)
          </span>
        </span>
        <select
          value={effort}
          onChange={(e) => setEffort(e.target.value as EffortChoice)}
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-sm focus:outline-none focus:border-zinc-600"
        >
          {EFFORT_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        onClick={() => void submit()}
        disabled={disabled}
        className="w-full px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-sm font-medium transition-colors"
      >
        {busy ? "spawning…" : "spawn"}
      </button>

      {error !== null && (
        <p className="text-xs text-red-400 font-mono break-all">{error}</p>
      )}
    </div>
  );
}
