import { describe, it, expect } from "bun:test";
import { execSync } from "node:child_process";
import { join } from "node:path";

// Guard: no `clobber note` should remain anywhere in the repo after the note→finding
// rename (#167). The assignment step-6 `clobber status` line is intentionally
// distinct and is not affected by this guard.
describe("no clobber note references (#167)", () => {
  it("grep finds zero occurrences of 'clobber note' in the repo", () => {
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    let output = "";
    try {
      output = execSync(
        'git grep -r --fixed-strings "clobber note" -- "*.ts" "*.md" "*.json" 2>&1',
        { cwd: repoRoot, encoding: "utf8" },
      );
    } catch {
      // git grep exits 1 when nothing matches — that's the success case.
      output = "";
    }
    expect(output.trim()).toBe("");
  });
});
