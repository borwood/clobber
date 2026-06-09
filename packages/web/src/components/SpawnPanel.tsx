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

const MODEL_CHOICES: readonly ModelChoice[] = ["default", "opus", "sonnet", "haiku", "fable"];

const DEFAULT_WAKE = "default";
const CUSTOM_WAKE = "custom";

export function SpawnPanel({ workspaceId, roleId, wakePrograms, onSpawned }: Props) {
  const [label, setLabel] = useState("");
  const [effort, setEffort] = useState<EffortChoice>("default");
  const [model, setModel] = useState<ModelChoice>("default");
  const [wakeProgram, setWakeProgram] = useState<string>(DEFAULT_WAKE);
  const [customPrompt, setCustomPrompt] = useState("");
  const [customSystem, setCustomSystem] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dropdown: "default" (role's default program), "custom" (caller kick + system),
  // then the role's named programs.
  const wakeProgramChoices: readonly string[] = [DEFAULT_WAKE, CUSTOM_WAKE, ...wakePrograms];
  const isCustom = wakeProgram === CUSTOM_WAKE;

  async function submit() {
    if (roleId === null) return;
    const trimmedLabel = label.trim();
    if (trimmedLabel.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const trimmedPrompt = customPrompt.trim();
      const trimmedSystem = customSystem.trim();
      const res = await api.spawn({
        workspace_id: workspaceId,
        role_id: roleId,
        label: trimmedLabel,
        wake_program: wakeProgram,
        ...(isCustom && trimmedPrompt.length > 0 ? { prompt: trimmedPrompt } : {}),
        ...(isCustom && trimmedSystem.length > 0 ? { system_addon: trimmedSystem } : {}),
        ...(effort === "default" ? {} : { effort }),
        ...(model === "default" ? {} : { model }),
      });
      onSpawned(res);
      setLabel("");
      setEffort("default");
      setModel("default");
      setWakeProgram(DEFAULT_WAKE);
      setCustomPrompt("");
      setCustomSystem("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const disabled = roleId === null || busy || label.trim().length === 0;

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
            (default = role's opening move; custom = caller-supplied kick)
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

      {isCustom && (
        <>
          <label className="block">
            <span className="block text-xs text-text-muted mb-1">
              prompt{" "}
              <span className="text-text-faint">(optional — the opening kick)</span>
            </span>
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              rows={5}
              className="w-full px-3 py-2 bg-surface border border-border rounded text-sm focus:outline-none focus:border-border-strong"
              placeholder={
                roleId === null
                  ? "select a role above first…"
                  : "leave blank to boot and wait…"
              }
              disabled={roleId === null}
            />
          </label>

          <label className="block">
            <span className="block text-xs text-text-muted mb-1">
              system addon{" "}
              <span className="text-text-faint">(optional — appended to layer C)</span>
            </span>
            <textarea
              value={customSystem}
              onChange={(e) => setCustomSystem(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 bg-surface border border-border rounded text-sm focus:outline-none focus:border-border-strong"
              placeholder="leave blank for no system addon…"
              disabled={roleId === null}
            />
          </label>
        </>
      )}

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
