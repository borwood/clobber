import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineRole, RoleManifestError } from "../src/role-manifest/index.ts";

let bundleRoot: string;

beforeEach(() => {
  bundleRoot = mkdtempSync(join(tmpdir(), "clobber-role-"));
  writeFileSync(join(bundleRoot, "system-prompt.md"), "you are a test role\n");
  writeFileSync(join(bundleRoot, "settings.overlay.json"), "{}\n");
  mkdirSync(join(bundleRoot, "skills"), { recursive: true });
  writeFileSync(join(bundleRoot, "skills", "whoami.md"), "# whoami\n");
});

afterEach(() => {
  rmSync(bundleRoot, { recursive: true, force: true });
});

const validManifest = {
  name: "test-role",
  description: "for tests",
  systemPromptPath: "system-prompt.md",
  allowedCliCommands: ["whoami"],
  settingsOverlayPath: "settings.overlay.json",
  skills: [{ name: "whoami", path: "skills/whoami.md" }],
  hookScripts: [],
} as const;

describe("defineRole", () => {
  it("returns a frozen LoadedRole when every referenced file exists", () => {
    const role = defineRole({ root: bundleRoot, manifest: validManifest });
    expect(role.bundleRoot).toBe(bundleRoot);
    expect(role.manifest.name).toBe("test-role");
    expect(Object.isFrozen(role)).toBe(true);
  });

  it("throws RoleManifestError if the manifest fails schema validation", () => {
    expect(() =>
      defineRole({
        root: bundleRoot,
        manifest: { ...validManifest, name: "" },
      }),
    ).toThrow(RoleManifestError);
  });

  it("throws RoleManifestError if the system prompt file is missing", () => {
    rmSync(join(bundleRoot, "system-prompt.md"));
    expect(() =>
      defineRole({ root: bundleRoot, manifest: validManifest }),
    ).toThrow(/system-prompt\.md/);
  });

  it("throws RoleManifestError if the settings overlay file is missing", () => {
    rmSync(join(bundleRoot, "settings.overlay.json"));
    expect(() =>
      defineRole({ root: bundleRoot, manifest: validManifest }),
    ).toThrow(/settings\.overlay\.json/);
  });

  it("throws RoleManifestError if a skill file is missing", () => {
    rmSync(join(bundleRoot, "skills", "whoami.md"));
    expect(() =>
      defineRole({ root: bundleRoot, manifest: validManifest }),
    ).toThrow(/whoami\.md/);
  });

  it("throws RoleManifestError if the settings overlay is not valid JSON", () => {
    writeFileSync(join(bundleRoot, "settings.overlay.json"), "not json{{{");
    expect(() =>
      defineRole({ root: bundleRoot, manifest: validManifest }),
    ).toThrow(RoleManifestError);
  });
});
