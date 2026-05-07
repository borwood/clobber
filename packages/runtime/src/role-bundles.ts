import type { LoadedRole } from "./role-manifest/index.ts";
import { managerRole } from "../roles/manager/manifest.ts";
import { workerRole } from "../roles/worker/manifest.ts";
import { workerBeeRole } from "../roles/worker-bee/manifest.ts";

const SHIPPED: readonly LoadedRole[] = [managerRole, workerRole, workerBeeRole];

const REGISTRY: ReadonlyMap<string, LoadedRole> = new Map(
  SHIPPED.map((role) => [role.manifest.name, role] as const),
);

export function loadRoleBundle(name: string): LoadedRole | null {
  return REGISTRY.get(name) ?? null;
}

export function enumerateShippedRoles(): readonly LoadedRole[] {
  return SHIPPED;
}
