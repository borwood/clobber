import {
  WorkspaceThemeSchema,
  DEFAULT_WORKSPACE_THEME,
  BUILT_IN_MODES,
  PFP_SIZE_PX,
  type BuiltInMode,
  type PfpSize,
  type WorkspaceTheme,
} from "@clobber/shared";

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
  readonly accent: string;
  readonly pfpSize: PfpSize;
  readonly tokens: Readonly<Record<string, string>>;
}

// Built-in mode → itself, no token overrides. Custom id → its base mode (inherit
// the base's surfaces + contrast), its pinned accent or the workspace accent, and
// its sparse token map. A dangling custom id THROWS — no silent fallback
// (Engineering Rule 3 / the simplest-fallback trap).
function resolveTheme(theme: WorkspaceTheme): ResolvedTheme {
  if (isBuiltInMode(theme.mode)) {
    return { mode: theme.mode, accent: theme.accent, pfpSize: theme.pfpSize, tokens: {} };
  }
  const custom = theme.custom.find((c) => c.id === theme.mode);
  if (custom === undefined) {
    throw new Error(`custom theme not found: ${theme.mode}`);
  }
  const accent = custom.accent === undefined ? theme.accent : custom.accent;
  return { mode: custom.base, accent, pfpSize: theme.pfpSize, tokens: custom.tokens };
}

function paint(theme: WorkspaceTheme): void {
  const root = document.documentElement;
  const resolved = resolveTheme(theme);
  root.dataset.theme = resolved.mode;
  root.dataset.accent = resolved.accent;
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
// paint. Absent cache → dark default. A tampered cache throws (Engineering Rule 3
// — no silent fallback); the DB value reconciles it on the next render regardless.
export function bootstrapTheme(): void {
  const raw = localStorage.getItem(STORAGE_KEY);
  const theme =
    raw === null
      ? DEFAULT_WORKSPACE_THEME
      : WorkspaceThemeSchema.parse(JSON.parse(raw));
  paint(theme);
}
