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

  it("excludes ADS stream files (name contains ':') even when newest", () => {
    writeNote("notes-real.md", "valid note", 5000);
    // ADS file is newer (ageMs=0)
    const adsPath = join(dir, "docker-fix.txt:Zone.Identifier");
    writeFileSync(adsPath, "[ZoneTransfer]\r\nZoneId=3\x00");
    const nowSec = Date.now() / 1000;
    utimesSync(adsPath, nowSec, nowSec);

    const out = composeOfficeContext(dir);
    expect(out).not.toContain("Zone.Identifier");
    expect(out).toContain("notes-real.md");
    expect(out).toContain("preview:");
    expect(out).not.toContain("\0");
  });

  it("excludes dotfiles even when newest", () => {
    writeNote("notes-real.md", "valid note", 5000);
    const dotPath = join(dir, ".hidden-state");
    writeFileSync(dotPath, "hidden content");
    const nowSec = Date.now() / 1000;
    utimesSync(dotPath, nowSec, nowSec);

    const out = composeOfficeContext(dir);
    expect(out).not.toContain(".hidden-state");
    expect(out).toContain("notes-real.md");
  });

  it("excludes binary files containing NUL bytes even when newest", () => {
    writeNote("notes-real.md", "valid note", 5000);
    // PNG-like header with NUL bytes
    const binPath = join(dir, "image.png");
    writeFileSync(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
    const nowSec = Date.now() / 1000;
    utimesSync(binPath, nowSec, nowSec);

    const out = composeOfficeContext(dir);
    expect(out).not.toContain("image.png");
    expect(out).toContain("notes-real.md");
    expect(out).toContain("preview:");
    expect(out).not.toContain("\0");
  });

  it("returns empty-office message when only non-note files are present", () => {
    const adsPath = join(dir, "file.txt:Zone.Identifier");
    writeFileSync(adsPath, "[ZoneTransfer]\r\nZoneId=3\x00");

    const out = composeOfficeContext(dir);
    expect(out).toContain("office is empty");
    expect(out).not.toContain("\0");
  });
});
