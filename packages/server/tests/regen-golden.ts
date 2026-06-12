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

// ASCII-escape all non-ASCII chars so the golden file is stable ASCII.
// Equivalent to /[-￿]/g without embedding literal high-byte chars in source.
const nonAscii = new RegExp("[\\u0080-\\uffff]", "g");
const escaped = JSON.stringify(golden, null, 2).replace(
  nonAscii,
  (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
);

writeFileSync(
  join(import.meta.dir, "fixtures", "effective-roles.golden.json"),
  escaped + "\n",
);

console.log("Golden regenerated.");
