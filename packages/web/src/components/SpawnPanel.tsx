import { useState } from "react";
import { api, type EffortLevel, type Model, type SpawnResponse } from "../api.ts";

interface Props {
  readonly workspaceId: string;
  readonly roleId: string | null;
  readonly wakePrograms: readonly string[];
  readonly onSpawned: (s: SpawnResponse) => void;
}

type EffortChoice = EffortLevel | "default";
type ModelChoice = Model | "default";

const EFFORT_CHOICES: readonly EffortChoice[] = [
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const MODEL_CHOICES: readonly ModelChoice[] = ["default", "opus", "sonnet", "haiku"];

const IDLE_WAKE_PROGRAM = "idle";

export function SpawnPanel({ workspaceId, roleId, wakePrograms, onSpawned }: Props) {
  const [prompt, setPrompt] = useState("");
  const [label, setLabel] = useState("");
  const [effort, setEffort] = useState<EffortChoice>("default");
  const [model, setModel] = useState<ModelChoice>("default");
  const [wakeProgram, setWakeProgram] = useState<string>(IDLE_WAKE_PROGRAM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wakeProgramChoices: readonly string[] = [IDLE_WAKE_PROGRAM, ...wakePrograms];

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
        ...(model === "default" ? {} : { model }),
        ...(wakeProgram === IDLE_WAKE_PROGRAM ? {} : { wake_program: wakeProgram }),
      });
      onSpawned(res);
      setPrompt("");
      setLabel("");
      setEffort("default");
      setModel("default");
      setWakeProgram(IDLE_WAKE_PROGRAM);
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
      <h2 className="text-sm uppercase tracking-wider text-text-subtle">spawn</h2>

      <label className="block">
        <span className="block text-xs text-text-muted mb-1">label</span>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. fix-flaky-test"
          className="w-full px-3 py-2 bg-surface border border-border rounded text-sm focus:outline-none focus:border-border-strong"
        />
      </label>

      <label className="block">
        <span className="block text-xs text-text-muted mb-1">prompt</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          className="w-full px-3 py-2 bg-surface border border-border rounded text-sm focus:outline-none focus:border-border-strong"
          placeholder={
            roleId === null
              ? "select a role above first…"
              : "Run the bash command `echo hello`…"
          }
          disabled={roleId === null}
        />
      </label>

      <label className="block">
        <span className="block text-xs text-text-muted mb-1">
          effort{" "}
          <span className="text-text-faint">
            (default = role's reasoning depth)
          </span>
        </span>
        <select
          value={effort}
          onChange={(e) => setEffort(e.target.value as EffortChoice)}
          className="w-full px-3 py-2 bg-surface border border-border rounded text-sm focus:outline-none focus:border-border-strong"
        >
          {EFFORT_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="block text-xs text-text-muted mb-1">
          model{" "}
          <span className="text-text-faint">
            (default = role's configured model)
          </span>
        </span>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value as ModelChoice)}
          className="w-full px-3 py-2 bg-surface border border-border rounded text-sm focus:outline-none focus:border-border-strong"
        >
          {MODEL_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="block text-xs text-text-muted mb-1">
          wake program{" "}
          <span className="text-text-faint">
            (idle = role's default opening move)
          </span>
        </span>
        <select
          value={wakeProgram}
          onChange={(e) => setWakeProgram(e.target.value)}
          className="w-full px-3 py-2 bg-surface border border-border rounded text-sm focus:outline-none focus:border-border-strong"
        >
          {wakeProgramChoices.map((choice) => (
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
        className="w-full px-3 py-2 rounded bg-accent-strong hover:bg-accent disabled:bg-elevated disabled:text-text-subtle text-sm font-medium transition-colors"
      >
        {busy ? "spawning…" : "spawn"}
      </button>

      {error !== null && (
        <p className="text-xs text-danger-text font-mono break-all">{error}</p>
      )}
    </div>
  );
}
