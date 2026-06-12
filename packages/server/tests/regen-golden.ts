import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRoleBundle } from "@clobber/runtime";
import { snapshotShippedBundle } from "../src/role-version-snapshot.ts";
import type { LoadedRole } from "@clobber/runtime";

function snapshotEffective(loaded: LoadedRole) {
  return snapshotShippedBundle({ loaded, allowedTools: loaded.allowedTools });
}

const golden = {
  manager: snapshotEffective(loadRoleBundle("manager")!),
  worker: snapshotEffective(loadRoleBundle("worker")!),
};

writeFileSync(
  join(import.meta.dir, "fixtures", "effective-roles.golden.json"),
  JSON.stringify(golden, null, 2) + "\n",
);

console.log("Golden regenerated.");
