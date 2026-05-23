import { describe, it, expect } from "bun:test";
import { RoleManifestSchema } from "../src/domain/role-manifest.ts";

const baseManifest = {
  name: "manager",
  description: "Owns workspace state and spawns workers.",
  systemPromptPath: "system-prompt.md",
  pluginTemplatePath: "plugin-template",
  allowedCliCommands: ["whoami"],
  persistent: true,
  defaultCeiling: 1,
};

describe("RoleManifestSchema", () => {
  it("accepts a minimal valid manifest", () => {
    const result = RoleManifestSchema.safeParse(baseManifest);
    expect(result.success).toBe(true);
  });

  it("rejects an empty name", () => {
    const result = RoleManifestSchema.safeParse({ ...baseManifest, name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty description", () => {
    const result = RoleManifestSchema.safeParse({ ...baseManifest, description: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an absolute systemPromptPath", () => {
    const result = RoleManifestSchema.safeParse({
      ...baseManifest,
      systemPromptPath: "/etc/passwd",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a systemPromptPath that escapes the bundle", () => {
    const result = RoleManifestSchema.safeParse({
      ...baseManifest,
      systemPromptPath: "../outside.md",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an absolute pluginTemplatePath", () => {
    const result = RoleManifestSchema.safeParse({
      ...baseManifest,
      pluginTemplatePath: "/abs/plugin",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a pluginTemplatePath that escapes the bundle", () => {
    const result = RoleManifestSchema.safeParse({
      ...baseManifest,
      pluginTemplatePath: "../escapee",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty allowed CLI command", () => {
    const result = RoleManifestSchema.safeParse({
      ...baseManifest,
      allowedCliCommands: ["whoami", ""],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate allowed CLI commands", () => {
    const result = RoleManifestSchema.safeParse({
      ...baseManifest,
      allowedCliCommands: ["whoami", "whoami"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts each effort level claude --effort understands", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      const result = RoleManifestSchema.safeParse({ ...baseManifest, effort: level });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an effort level outside the claude --effort enum", () => {
    const result = RoleManifestSchema.safeParse({ ...baseManifest, effort: "extreme" });
    expect(result.success).toBe(false);
  });
});
