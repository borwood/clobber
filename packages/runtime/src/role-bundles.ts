import type { LoadedRole } from "./role-manifest/index.ts";
import { managerRole } from "../roles/manager/manifest.ts";
import { workerRole } from "../roles/worker/manifest.ts";

const REGISTRY: ReadonlyMap<string, LoadedRole> = new Map([
  [managerRole.manifest.name, managerRole],
  [workerRole.manifest.name, workerRole],
]);

export function loadRoleBundle(name: string): LoadedRole | null {
  return REGISTRY.get(name) ?? null;
}
