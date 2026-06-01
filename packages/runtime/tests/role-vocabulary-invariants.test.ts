import { describe, it, expect } from "bun:test";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

// Sunset role-name vocabulary from the autonomy v1 milestone (#142, #144).
// Tokens are assembled from non-matching parts so this test file itself stays
// out of the search hit list when the grep targets `packages/`.
const forbiddenTokens = [
  "worker" + "-bee",
  "worker" + "Bee",
  "Worker" + "Bee",
  "seed" + "-todos",
  "seed" + "Todos",
];

describe("role vocabulary invariants (#144)", () => {
  it("active code, tests, and docs contain none of the sunset role-name tokens", () => {
    const pattern = forbiddenTokens.join("\\|");
    const targets = ["packages/", "README.md", "CLAUDE.md", "docs/"];
    let stdout = "";
    try {
      stdout = execSync(`grep -rln '${pattern}' ${targets.join(" ")}`, {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
    } catch (e) {
      const err = e as { status?: number };
      if (err.status === 1) return;
      throw e;
    }
    const matches = stdout.trim().split("\n").filter(Boolean);
    expect(matches).toEqual([]);
  });
});
