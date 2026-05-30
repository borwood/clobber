import { useState } from "react";
import {
  BUILT_IN_MODES,
  BUILT_IN_ACCENTS,
  SEMANTIC_TOKENS,
  CssColorSchema,
  type BuiltInMode,
  type BuiltInAccent,
  type CustomTheme,
  type SemanticToken,
} from "@clobber/shared";

interface Props {
  readonly custom: readonly CustomTheme[];
  readonly selectedMode: string;
  readonly onChange: (next: CustomTheme[]) => void;
  readonly onSelect: (mode: string) => void;
}

// #370 custom-theme subsection: create from a base, override a sparse subset of
// tokens, edit/delete, and select. Edits write straight back through `onChange`,
// so the modal's live-preview effect repaints on every keystroke.
export function CustomThemeEditor({ custom, selectedMode, onChange, onSelect }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);

  function replace(id: string, patch: Partial<CustomTheme>): void {
    onChange(custom.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function create(): void {
    const id = crypto.randomUUID();
    onChange([...custom, { id, name: "new theme", base: "dark", tokens: {} }]);
    setEditingId(id);
    onSelect(id);
  }

  function remove(id: string): void {
    onChange(custom.filter((c) => c.id !== id));
    if (editingId === id) setEditingId(null);
    if (selectedMode === id) onSelect("dark");
  }

  const editing = custom.find((c) => c.id === editingId);

  return (
    <div className="px-4 py-3 border-t border-border space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-text-muted uppercase tracking-wide">custom themes</div>
        <button
          type="button"
          onClick={create}
          className="text-xs text-accent-text hover:text-accent-hover"
        >
          + new
        </button>
      </div>

      {custom.length === 0 && (
        <div className="text-xs text-text-subtle">
          none yet — start one from a built-in base.
        </div>
      )}

      <div className="space-y-1.5">
        {custom.map((c) => (
          <div key={c.id} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSelect(c.id)}
              className={`flex-1 text-left px-3 py-1.5 rounded border bg-bg text-xs ${
                selectedMode === c.id
                  ? "border-accent text-text"
                  : "border-border text-text-dim hover:border-border-strong"
              }`}
            >
              {c.name} <span className="text-text-subtle">· from {c.base}</span>
            </button>
            <button
              type="button"
              onClick={() => setEditingId(editingId === c.id ? null : c.id)}
              className="text-xs text-text-muted hover:text-text-dim px-1"
            >
              {editingId === c.id ? "done" : "edit"}
            </button>
            <button
              type="button"
              onClick={() => remove(c.id)}
              className="text-xs text-danger-text hover:text-danger px-1"
            >
              delete
            </button>
          </div>
        ))}
      </div>

      {editing !== undefined && (
        <CustomThemeForm
          key={editing.id}
          theme={editing}
          onPatch={(patch) => replace(editing.id, patch)}
        />
      )}
    </div>
  );
}

interface FormProps {
  readonly theme: CustomTheme;
  readonly onPatch: (patch: Partial<CustomTheme>) => void;
}

// Keyed by theme id so it remounts (fresh drafts) when the edited theme changes.
// `drafts` holds the raw per-token text — including invalid in-progress values —
// while only entries that pass CssColorSchema are committed up as stored tokens.
function CustomThemeForm({ theme, onPatch }: FormProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() => ({ ...theme.tokens }));

  function commit(next: Record<string, string>): void {
    const tokens: Partial<Record<SemanticToken, string>> = {};
    for (const [token, value] of Object.entries(next)) {
      if (CssColorSchema.safeParse(value).success) tokens[token as SemanticToken] = value;
    }
    onPatch({ tokens });
  }

  function editToken(token: SemanticToken, raw: string): void {
    const next = { ...drafts };
    if (raw === "") delete next[token];
    else next[token] = raw;
    setDrafts(next);
    commit(next);
  }

  function resetToBase(): void {
    setDrafts({});
    onPatch({ tokens: {} });
  }

  return (
    <div className="space-y-3 border border-border rounded p-3 bg-surface">
      <input
        type="text"
        value={theme.name}
        onChange={(e) => onPatch({ name: e.target.value })}
        placeholder="theme name"
        className="w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text"
      />

      <div className="space-y-1.5">
        <div className="text-xs text-text-subtle">base</div>
        <div className="flex gap-2">
          {BUILT_IN_MODES.map((m: BuiltInMode) => (
            <button
              key={m}
              type="button"
              onClick={() => onPatch({ base: m })}
              className={`flex-1 px-2 py-1 rounded border text-xs capitalize ${
                theme.base === m
                  ? "border-accent text-text"
                  : "border-border text-text-dim hover:border-border-strong"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-xs text-text-subtle">accent</div>
        <div className="flex gap-2 items-center">
          <button
            type="button"
            onClick={() => onPatch({ accent: undefined })}
            className={`px-2 py-1 rounded border text-xs ${
              theme.accent === undefined
                ? "border-accent text-text"
                : "border-border text-text-dim hover:border-border-strong"
            }`}
          >
            inherit
          </button>
          {BUILT_IN_ACCENTS.map((a: BuiltInAccent) => (
            <button
              key={a}
              type="button"
              data-accent={a}
              onClick={() => onPatch({ accent: a })}
              title={a}
              aria-label={a}
              className={`h-6 w-6 rounded-full bg-accent border-2 ${
                theme.accent === a ? "border-text" : "border-transparent"
              }`}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-xs text-text-subtle">tokens (only edited are stored)</div>
        <button
          type="button"
          onClick={resetToBase}
          className="text-xs text-text-muted hover:text-text-dim"
        >
          reset to base
        </button>
      </div>
      <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
        {SEMANTIC_TOKENS.map((token: SemanticToken) => {
          const text = drafts[token] === undefined ? "" : drafts[token];
          const invalid = text !== "" && !CssColorSchema.safeParse(text).success;
          return (
            <label key={token} className="flex items-center gap-2 text-xs">
              <span className="w-28 shrink-0 font-mono text-text-muted truncate">{token}</span>
              <input
                type="text"
                value={text}
                onChange={(e) => editToken(token, e.target.value)}
                placeholder="inherit"
                className={`flex-1 bg-bg border rounded px-2 py-0.5 font-mono text-text ${
                  invalid ? "border-danger" : "border-border"
                }`}
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}
