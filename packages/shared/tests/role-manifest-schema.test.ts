import { describe, it, expect } from "bun:test";
import { RoleManifestSchema } from "../src/domain/role-manifest.ts";

const baseManifest = {
  name: "manager",
  description: "Owns workspace state and spawns workers.",
  systemPromptPath: "system-prompt.md",
  allowedCliCommands: ["whoami"],
  settingsOverlayPath: "settings.overlay.json",
  skills: [{ name: "whoami", path: "skills/whoami.md" }],
  hookScripts: [],
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

  it("rejects an absolute skill path", () => {
    const result = RoleManifestSchema.safeParse({
      ...baseManifest,
      skills: [{ name: "x", path: "/abs/x.md" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a hookScript with an invalid event name", () => {
    const result = RoleManifestSchema.safeParse({
      ...baseManifest,
      hookScripts: [{ event: "NotARealEvent", path: "hooks/x.sh" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a hookScript with a real event name", () => {
    const result = RoleManifestSchema.safeParse({
      ...baseManifest,
      hookScripts: [{ event: "SessionStart", path: "hooks/start.sh" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty allowed CLI command", () => {
    const result = RoleManifestSchema.safeParse({
      ...baseManifest,
      allowedCliCommands: ["whoami", ""],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate skill names", () => {
    const result = RoleManifestSchema.safeParse({
      ...baseManifest,
      skills: [
        { name: "whoami", path: "skills/whoami.md" },
        { name: "whoami", path: "skills/dup.md" },
      ],
    });
    expect(result.success).toBe(false);
  });
});
