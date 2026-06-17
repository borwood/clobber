import { useEffect } from "react";
import {
  BUILT_IN_MODES,
  BUILT_IN_ACCENTS,
  PFP_SIZES,
  type Accent,
  type BuiltInAccent,
  type CustomTheme,
  type PfpSize,
  type WorkspaceTheme,
} from "@clobber/shared";
import { previewWorkspaceTheme } from "../../lib/apply-theme.ts";
import { CustomThemeEditor } from "../CustomThemeEditor.tsx";
import type { OverrideProps } from "./SchemaField.tsx";

// The differentiated theme editor, re-introduced as an override branch over the
// structural renderer. Theme's mode is a free union and its custom themes are a
// color editor — neither auto-renders honestly, so this bespoke control owns the
// whole `theme` field, including the live on-canvas preview.
export function ThemeField({ value, onChange }: OverrideProps) {
  const theme = value as WorkspaceTheme;
  const { mode, accent, custom, pfpSize } = theme;

  useEffect(() => {
    previewWorkspaceTheme({ mode, accent, custom, pfpSize });
  }, [mode, accent, custom, pfpSize]);

  function patch(p: Partial<WorkspaceTheme>) {
    onChange({ ...theme, ...p });
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="text-xs text-text-subtle">mode</div>
        <div className="flex gap-2">
          {BUILT_IN_MODES.map((m) => (
            <button
              key={m}
              type="button"
              data-theme={m}
              onClick={() => patch({ mode: m })}
              className={`flex-1 flex items-center gap-2 px-3 py-2 rounded border bg-bg ${
                mode === m ? "border-accent" : "border-border hover:border-border-strong"
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
              onClick={() => patch({ accent: a as BuiltInAccent })}
              title={a}
              aria-label={a}
              className={`h-7 w-7 rounded-full bg-accent border-2 ${
                accent === a ? "border-text" : "border-transparent"
              }`}
            />
          ))}
          <CustomAccentSwatch accent={accent} onPick={(color) => patch({ accent: { kind: "custom", color } })} />
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-xs text-text-subtle">agent picture size</div>
        <div className="flex gap-2">
          {PFP_SIZES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => patch({ pfpSize: s as PfpSize })}
              className={`flex-1 px-3 py-2 rounded border bg-bg text-xs capitalize ${
                pfpSize === s
                  ? "border-accent text-text-dim"
                  : "border-border hover:border-border-strong text-text-subtle"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <CustomThemeEditor
        custom={custom}
        selectedMode={mode}
        onChange={(c: CustomTheme[]) => patch({ custom: c })}
        onSelect={(m: string) => patch({ mode: m })}
      />
    </div>
  );
}

// A pick-your-own accent swatch. A rainbow ring signals the affordance when no
// custom accent is set; once picked, the swatch shows the chosen color and reads
// as selected. The full accent ramp is derived from this seed at apply time.
function CustomAccentSwatch({ accent, onPick }: { accent: Accent; onPick: (color: string) => void }) {
  const isCustom = typeof accent === "object";
  const hex = isCustom && accent.color.startsWith("#") ? accent.color : "#10b981";
  return (
    <label
      title="Custom accent"
      className={`relative h-7 w-7 rounded-full border-2 cursor-pointer overflow-hidden ${
        isCustom ? "border-text" : "border-transparent"
      }`}
      style={{
        background: isCustom
          ? hex
          : "conic-gradient(from 0deg, #ef4444, #f59e0b, #10b981, #3b82f6, #8b5cf6, #ef4444)",
      }}
    >
      <input
        type="color"
        value={hex}
        onChange={(e) => onPick(e.target.value)}
        className="absolute inset-0 h-full w-full opacity-0 cursor-pointer"
      />
    </label>
  );
}
