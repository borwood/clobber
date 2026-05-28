import type { LayoutNode, PaneNode } from "./types.ts";

export const CLOSED_RING_SIZE = 10;

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

const SAVED_PREFIX = "saved:";

export function savedLayoutKey(workspaceSlug: string, name: string): string {
  return `${layoutStorageKey(workspaceSlug)}:${SAVED_PREFIX}${name}`;
}

export function saveSavedLayout(
  workspaceSlug: string,
  name: string,
  layout: LayoutNode,
): void {
  localStorage.setItem(savedLayoutKey(workspaceSlug, name), JSON.stringify(layout));
}

export function loadSavedLayout(
  workspaceSlug: string,
  name: string,
): LayoutNode | null {
  const raw = localStorage.getItem(savedLayoutKey(workspaceSlug, name));
  if (raw === null) return null;
  return JSON.parse(raw) as LayoutNode;
}

export function listSavedLayouts(workspaceSlug: string): string[] {
  const prefix = `${layoutStorageKey(workspaceSlug)}:${SAVED_PREFIX}`;
  const names: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null && key.startsWith(prefix)) {
      names.push(key.slice(prefix.length));
    }
  }
  return names.sort();
}

export interface ClosedPaneEntry {
  readonly pane: PaneNode;
  readonly label: string;
  readonly closedAt: number;
}

export function closedRingKey(workspaceSlug: string): string {
  return `${layoutStorageKey(workspaceSlug)}:closed-ring`;
}

export function listClosedPanes(workspaceSlug: string): ClosedPaneEntry[] {
  const raw = localStorage.getItem(closedRingKey(workspaceSlug));
  if (raw === null) return [];
  return JSON.parse(raw) as ClosedPaneEntry[];
}

export function pushClosedPane(
  workspaceSlug: string,
  pane: PaneNode,
  label: string,
  closedAt: number,
): void {
  const current = listClosedPanes(workspaceSlug);
  const next = [{ pane, label, closedAt }, ...current].slice(0, CLOSED_RING_SIZE);
  localStorage.setItem(closedRingKey(workspaceSlug), JSON.stringify(next));
}
