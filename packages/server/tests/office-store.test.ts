import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { officePathFor, ensureOffice, removeOffice } from "../src/office-store.ts";

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "clobber-office-"));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

const AGENT_ID = "00000000-0000-4000-8000-000000000001";

describe("office-store", () => {
  it("officePathFor returns <repo>/.clobber/offices/<agent-id>", () => {
    expect(officePathFor(repoPath, AGENT_ID)).toBe(
      join(repoPath, ".clobber", "offices", AGENT_ID),
    );
  });

  it("ensureOffice creates the directory and returns its path", () => {
    const path = ensureOffice(repoPath, AGENT_ID);
    expect(path).toBe(join(repoPath, ".clobber", "offices", AGENT_ID));
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).isDirectory()).toBe(true);
  });

  it("ensureOffice is idempotent and preserves existing contents", () => {
    const path = ensureOffice(repoPath, AGENT_ID);
    writeFileSync(join(path, "notes.md"), "first session");

    const again = ensureOffice(repoPath, AGENT_ID);
    expect(again).toBe(path);
    expect(readFileSync(join(path, "notes.md"), "utf8")).toBe("first session");
  });

  it("removeOffice deletes the directory and its contents", () => {
    const path = ensureOffice(repoPath, AGENT_ID);
    writeFileSync(join(path, "scratch.txt"), "x");

    removeOffice(repoPath, AGENT_ID);
    expect(existsSync(path)).toBe(false);
  });

  it("removeOffice is a no-op when the directory does not exist", () => {
    expect(() => removeOffice(repoPath, AGENT_ID)).not.toThrow();
  });

  it("officePathFor is pure — does not touch the filesystem", () => {
    const path = officePathFor(repoPath, AGENT_ID);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(repoPath, ".clobber"))).toBe(false);
  });
});
