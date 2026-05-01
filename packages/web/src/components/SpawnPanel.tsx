import { useState } from "react";
import { api, type SpawnResponse } from "../api.ts";

interface Props {
  readonly onSpawned: (s: SpawnResponse) => void;
}

export function SpawnPanel({ onSpawned }: Props) {
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("/tmp");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (prompt.trim().length === 0 || cwd.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.spawn({
        prompt,
        cwd,
        permissionMode: "bypassPermissions",
        allowedTools: ["Bash", "Read"],
      });
      onSpawned(res);
      setPrompt("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm uppercase tracking-wider text-zinc-500">spawn agent</h2>

      <label className="block">
        <span className="block text-xs text-zinc-400 mb-1">cwd</span>
        <input
          type="text"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-sm font-mono focus:outline-none focus:border-zinc-600"
        />
      </label>

      <label className="block">
        <span className="block text-xs text-zinc-400 mb-1">prompt</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-sm focus:outline-none focus:border-zinc-600"
          placeholder="Run the bash command `echo hello`..."
        />
      </label>

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || prompt.trim().length === 0}
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
