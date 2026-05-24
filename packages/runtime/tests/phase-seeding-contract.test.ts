import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

// #200: the worker-facing phase-seeding contract must stay tool-agnostic.
// A dogfood worker (on #174 / PR #199) received a contract that hard-named one
// task tool (`TodoWrite`) which its harness didn't expose — it adapted to the
// `Task*` family on its own and reported the drift. Naming a single tool as THE
// mechanism is the bug regardless of WHICH tool is named: a `Task*`-only
// imperative breaks the inverse harness just as a `TodoWrite`-only one did.
// These files must instead present the seed tool as harness-dependent.
const contractFiles = [
  "packages/runtime/roles/worker/system-prompt.md",
  "packages/runtime/roles/manager/plugin-template/skills/assignment/SKILL.md",
];

describe("phase-seeding contract is tool-agnostic (#200)", () => {
  for (const rel of contractFiles) {
    const text = readFileSync(join(REPO_ROOT, rel), "utf8");

    it(`${rel} names both task-tool families, not a single hard-coded one`, () => {
      // The contract teaches the worker to look for whichever its harness
      // exposes, so both candidate families must be named.
      expect(text).toMatch(/TodoWrite/);
      expect(text).toMatch(/Task\*/);
    });

    it(`${rel} carries no unconditional single-tool imperative`, () => {
      // Regression guard: the original sin was "call `TodoWrite` with its
      // contents before any other tool call" — an unconditional imperative
      // naming exactly one tool. Forbid that shape for either family.
      expect(text).not.toMatch(/call `?TodoWrite`? with its contents/i);
      expect(text).not.toMatch(/call `?Task(Create|Update)`? with its contents/i);
    });
  }
});
