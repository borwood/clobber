import type { LoadedRole } from "./role-manifest/index.ts";
import { managerRole } from "../roles/manager/manifest.ts";

const REGISTRY: ReadonlyMap<string, LoadedRole> = new Map([
  [managerRole.manifest.name, managerRole],
]);

export function loadRoleBundle(name: string): LoadedRole | null {
  return REGISTRY.get(name) ?? null;
}
