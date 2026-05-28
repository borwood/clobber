import type { LayoutNode } from "./types.ts";

export function layoutStorageKey(workspaceSlug: string): string {
  return `clobber:layout:v1:${workspaceSlug}`;
}

export function loadLayout(workspaceSlug: string): LayoutNode | null {
  const raw = localStorage.getItem(layoutStorageKey(workspaceSlug));
  if (raw === null) return null;
  return JSON.parse(raw) as LayoutNode;
}

export function saveLayout(workspaceSlug: string, layout: LayoutNode): void {
  localStorage.setItem(layoutStorageKey(workspaceSlug), JSON.stringify(layout));
}
