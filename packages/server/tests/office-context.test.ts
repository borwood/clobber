import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeOfficeContext } from "../src/office-context.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clobber-office-context-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeNote(name: string, body: string, ageMs = 0): void {
  const path = join(dir, name);
  writeFileSync(path, body);
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(path, t, t);
  }
}

describe("composeOfficeContext", () => {
  it("returns the empty-office message when no notes exist", () => {
    const out = composeOfficeContext(dir);
    expect(out).toContain("[Previously in this office]");
    expect(out).toContain("office is empty");
    expect(out).toContain("[End of previously]");
  });

  it("includes a head-truncated preview of the single newest note", () => {
    const body = "first line\n" + "x".repeat(2000);
    writeNote("notes-2026-05-04-120000.md", body);

    const out = composeOfficeContext(dir, { previewBytes: 100 });
    expect(out).toContain("notes-2026-05-04-120000.md");
    expect(out).toContain("preview:");
    expect(out).toContain("first line");
    // head-truncated preview should be shorter than the original
    expect(out.length).toBeLessThan(body.length + 500);
  });

  it("lists up to maxFiles newest-first; older files have no preview", () => {
    writeNote("notes-2026-05-04-120000.md", "newest", 0);
    writeNote("notes-2026-05-03-120000.md", "yesterday", 24 * 3600 * 1000);
    writeNote("notes-2026-05-02-120000.md", "older", 48 * 3600 * 1000);
    writeNote("notes-2026-04-30-120000.md", "way older", 5 * 24 * 3600 * 1000);
    writeNote("notes-2026-04-29-120000.md", "ancient", 6 * 24 * 3600 * 1000);
    writeNote("notes-2026-04-28-120000.md", "should be cut", 7 * 24 * 3600 * 1000);

    const out = composeOfficeContext(dir, { maxFiles: 5, previewBytes: 50 });
    expect(out).toContain("notes-2026-05-04-120000.md");
    expect(out).toContain("notes-2026-04-29-120000.md");
    expect(out).not.toContain("notes-2026-04-28-120000.md");
    // Only the newest gets a preview line
    const previewMatches = out.match(/preview:/g);
    expect(previewMatches).not.toBeNull();
    expect(previewMatches!.length).toBe(1);
  });

  it("ignores non-file entries (subdirectories) in the office", () => {
    writeNote("notes-real.md", "real");
    // Create a subdir
    require("node:fs").mkdirSync(join(dir, "subdir"));
    const out = composeOfficeContext(dir);
    expect(out).toContain("notes-real.md");
    expect(out).not.toContain("subdir");
  });
});
