import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineRole, RoleManifestError } from "../src/role-manifest/index.ts";

let bundleRoot: string;

beforeEach(() => {
  bundleRoot = mkdtempSync(join(tmpdir(), "clobber-role-"));
  writeFileSync(join(bundleRoot, "system-prompt.md"), "you are a test role\n");
  mkdirSync(join(bundleRoot, "plugin-template", ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(bundleRoot, "plugin-template", ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "test-role", description: "for tests", version: "0.0.1" }),
  );
  mkdirSync(join(bundleRoot, "plugin-template", "skills", "whoami"), { recursive: true });
  writeFileSync(
    join(bundleRoot, "plugin-template", "skills", "whoami", "SKILL.md"),
    "---\nname: whoami\ndescription: who\n---\n# whoami\n",
  );
  mkdirSync(join(bundleRoot, "plugin-template", "hooks"), { recursive: true });
  writeFileSync(
    join(bundleRoot, "plugin-template", "hooks", "hooks.json"),
    JSON.stringify({ SessionStart: [] }),
  );
});

afterEach(() => {
  rmSync(bundleRoot, { recursive: true, force: true });
});

const validManifest = {
  name: "test-role",
  description: "for tests",
  systemPromptPath: "system-prompt.md",
  pluginTemplatePath: "plugin-template",
  allowedCliCommands: ["whoami"],
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

  it("throws RoleManifestError if the plugin template directory is missing", () => {
    rmSync(join(bundleRoot, "plugin-template"), { recursive: true });
    expect(() =>
      defineRole({ root: bundleRoot, manifest: validManifest }),
    ).toThrow(/plugin template/);
  });

  it("throws RoleManifestError if .claude-plugin/plugin.json is missing", () => {
    rmSync(join(bundleRoot, "plugin-template", ".claude-plugin", "plugin.json"));
    expect(() =>
      defineRole({ root: bundleRoot, manifest: validManifest }),
    ).toThrow(/plugin manifest/);
  });

  it("throws RoleManifestError if plugin.json is not valid JSON", () => {
    writeFileSync(
      join(bundleRoot, "plugin-template", ".claude-plugin", "plugin.json"),
      "not json{{{",
    );
    expect(() =>
      defineRole({ root: bundleRoot, manifest: validManifest }),
    ).toThrow(RoleManifestError);
  });

  it("throws RoleManifestError if plugin.json name does not match manifest name", () => {
    writeFileSync(
      join(bundleRoot, "plugin-template", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "wrong-name", description: "x", version: "0.0.1" }),
    );
    expect(() =>
      defineRole({ root: bundleRoot, manifest: validManifest }),
    ).toThrow(/does not match role name/);
  });

  it("throws RoleManifestError if hooks/hooks.json exists but is not valid JSON", () => {
    writeFileSync(
      join(bundleRoot, "plugin-template", "hooks", "hooks.json"),
      "not json",
    );
    expect(() =>
      defineRole({ root: bundleRoot, manifest: validManifest }),
    ).toThrow(/hooks file is not valid JSON/);
  });

  it("accepts a role with no hooks/hooks.json", () => {
    rmSync(join(bundleRoot, "plugin-template", "hooks"), { recursive: true });
    const role = defineRole({ root: bundleRoot, manifest: validManifest });
    expect(role.manifest.name).toBe("test-role");
  });
});
