import {
  WorkspaceThemeSchema,
  DEFAULT_WORKSPACE_THEME,
  type WorkspaceTheme,
} from "@clobber/shared";

// The active workspace's theme drives `<html data-theme data-accent>`, which the
// per-mode / per-accent token blocks in index.css key off. This module is the one
// place that touches those attributes + the flash-guard cache, so React, the
// pre-render bootstrap, and the no-workspace landing all paint through it.

const STORAGE_KEY = "clobber:theme";

function setAttrs(theme: WorkspaceTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme.mode;
  root.dataset.accent = theme.accent;
}

// Active-workspace apply: paint AND cache, so the next reload can repaint from
// the cache (bootstrapTheme) before React mounts — no flash of dark on a
// light/paper workspace.
export function applyWorkspaceTheme(theme: WorkspaceTheme): void {
  setAttrs(theme);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
}

// Landing / no-workspace apply: paint without overwriting the cached
// active-workspace theme, so reloading straight into a light/paper workspace URL
// still repaints from its cache rather than the dark landing default.
export function applyLandingTheme(): void {
  setAttrs(DEFAULT_WORKSPACE_THEME);
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
  setAttrs(theme);
}
