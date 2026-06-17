import {
  WorkspaceThemeSchema,
  DEFAULT_WORKSPACE_THEME,
  BUILT_IN_MODES,
  PFP_SIZE_PX,
  type Accent,
  type BuiltInMode,
  type PfpSize,
  type WorkspaceTheme,
} from "@clobber/shared";

// The built-in accent ramp's (lightness, chroma) ladder, lifted from the
// emerald block in index.css. A custom accent reuses this ladder but takes its
// HUE from the picked color: `oklch(from <picked> L C h)` keeps the proven
// per-step lightness/chroma while re-hueing the whole ramp. accent-fg (the
// text-on-accent token) stays mode-level — a refinement could derive it too.
const ACCENT_RAMP: readonly (readonly [string, number, number])[] = [
  ["accent", 0.596, 0.145],
  ["accent-strong", 0.508, 0.118],
  ["accent-hover", 0.696, 0.17],
  ["accent-text", 0.765, 0.177],
  ["accent-muted", 0.378, 0.077],
  ["accent-deep", 0.262, 0.051],
];

export function customAccentProps(color: string): Record<string, string> {
  return Object.fromEntries(
    ACCENT_RAMP.map(([token, l, c]) => [token, `oklch(from ${color} ${l} ${c} h)`]),
  );
}

// A built-in accent paints via the [data-accent] attribute (its ramp lives in
// index.css); a custom accent paints "custom" + injects the derived ramp inline.
function accentToDom(accent: Accent): { readonly attr: string; readonly tokens: Record<string, string> } {
  if (typeof accent === "string") return { attr: accent, tokens: {} };
  return { attr: "custom", tokens: customAccentProps(accent.color) };
}

// The active workspace's theme drives `<html data-theme data-accent>`, which the
// per-mode / per-accent token blocks in index.css key off. A custom theme (#370)
// resolves to its BASE mode here, then injects its overridden tokens as inline
// `--color-*` props — so un-overridden tokens fall through to the base's block
// (that absence IS the sparse inheritance). This module is the one place that
// touches those attributes + props + the flash-guard cache, so React, the
// pre-render bootstrap, and the no-workspace landing all paint through it.

const STORAGE_KEY = "clobber:theme";

// The inline `--color-*` props a custom theme last injected. Tracked module-wide
// so a theme switch can clear the previous theme's props before painting the next
// (a built-in injects none → its switch fully clears any custom residue).
let appliedCustomProps: string[] = [];

function isBuiltInMode(mode: string): mode is BuiltInMode {
  return (BUILT_IN_MODES as readonly string[]).includes(mode);
}

interface ResolvedTheme {
  readonly mode: BuiltInMode;
  readonly accentAttr: string;
  readonly pfpSize: PfpSize;
  readonly tokens: Readonly<Record<string, string>>;
}

// Built-in mode → itself, no token overrides. Custom id → its base mode (inherit
// the base's surfaces + contrast), its pinned accent or the workspace accent, and
// its sparse token map. A dangling custom id THROWS — no silent fallback
// (Engineering Rule 3 / the simplest-fallback trap). A custom accent contributes
// its derived ramp to tokens; an explicit custom-theme token override still wins
// (spread last).
function resolveTheme(theme: WorkspaceTheme): ResolvedTheme {
  if (isBuiltInMode(theme.mode)) {
    const a = accentToDom(theme.accent);
    return { mode: theme.mode, accentAttr: a.attr, pfpSize: theme.pfpSize, tokens: a.tokens };
  }
  const custom = theme.custom.find((c) => c.id === theme.mode);
  if (custom === undefined) {
    throw new Error(`custom theme not found: ${theme.mode}`);
  }
  const accent = custom.accent === undefined ? theme.accent : custom.accent;
  const a = accentToDom(accent);
  return { mode: custom.base, accentAttr: a.attr, pfpSize: theme.pfpSize, tokens: { ...a.tokens, ...custom.tokens } };
}

function paint(theme: WorkspaceTheme): void {
  const root = document.documentElement;
  const resolved = resolveTheme(theme);
  root.dataset.theme = resolved.mode;
  root.dataset.accent = resolved.accentAttr;
  root.style.setProperty("--pfp-size", `${PFP_SIZE_PX[resolved.pfpSize]}px`);

  for (const prop of appliedCustomProps) root.style.removeProperty(prop);
  appliedCustomProps = [];
  for (const [token, value] of Object.entries(resolved.tokens)) {
    const prop = `--color-${token}`;
    root.style.setProperty(prop, value);
    appliedCustomProps.push(prop);
  }
}

// Active-workspace apply: paint AND cache, so the next reload can repaint from
// the cache (bootstrapTheme) before React mounts — no flash of dark on a
// light/paper/custom workspace.
export function applyWorkspaceTheme(theme: WorkspaceTheme): void {
  paint(theme);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
}

// Live preview (#370 modal): paint WITHOUT caching, so the settings modal can
// show a theme on the real UI before save and revert by re-previewing the saved
// theme on cancel — neither touches the flash-guard cache, which still reflects
// the last committed theme for the next reload.
export function previewWorkspaceTheme(theme: WorkspaceTheme): void {
  paint(theme);
}

// Landing / no-workspace apply: paint without overwriting the cached
// active-workspace theme, so reloading straight into a light/paper workspace URL
// still repaints from its cache rather than the dark landing default.
export function applyLandingTheme(): void {
  paint(DEFAULT_WORKSPACE_THEME);
}

// Pre-React boot: repaint from the cached active-workspace theme before the first
// paint. The cache is a DISPOSABLE flash-guard, not authoritative state — so a
// value written under a prior theme shape (the schema evolves, e.g. accent
// widening to allow custom colors) must NOT brick boot. Absent OR schema-
// incompatible → default; the DB-driven render reconciles and rewrites the cache
// within the first frame. safeParse (not parse) because the DB, never this cache,
// is the source of truth — this is forward-compat, not silent error-swallowing.
export function bootstrapTheme(): void {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    paint(DEFAULT_WORKSPACE_THEME);
    return;
  }
  const parsed = WorkspaceThemeSchema.safeParse(JSON.parse(raw));
  paint(parsed.success ? parsed.data : DEFAULT_WORKSPACE_THEME);
}
