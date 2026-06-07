import { describe, it, expect } from "bun:test";
import {
  allCapabilityNames,
  capabilityNamesByTag,
  CLI_CAPABILITY_REGISTRY,
} from "../src/domain/cli-capabilities.ts";

describe("allCapabilityNames", () => {
  it("returns every key in CLI_CAPABILITY_REGISTRY", () => {
    const names = allCapabilityNames();
    const registryKeys = Object.keys(CLI_CAPABILITY_REGISTRY);
    expect(new Set(names)).toEqual(new Set(registryKeys));
  });

  it("is non-empty", () => {
    expect(allCapabilityNames().length).toBeGreaterThan(0);
  });

  it("includes internal verbs (test-tool)", () => {
    expect(allCapabilityNames()).toContain("test-tool");
  });

  it("includes known verbs across all tags", () => {
    const names = allCapabilityNames();
    expect(names).toContain("agents");       // read
    expect(names).toContain("ask");          // write
    expect(names).toContain("spawn");        // admin
    expect(names).toContain("roles.commit"); // admin
  });
});

describe("capabilityNamesByTag", () => {
  it("returns only read-tagged verbs for tag:read", () => {
    const readNames = capabilityNamesByTag("read");
    expect(readNames).toContain("agents");
    expect(readNames).toContain("whoami");
    expect(readNames).toContain("roles.diff");
    expect(readNames).not.toContain("spawn");
    expect(readNames).not.toContain("ask");
    for (const name of readNames) {
      expect(CLI_CAPABILITY_REGISTRY[name]?.tag).toBe("read");
    }
  });

  it("returns only write-tagged verbs for tag:write", () => {
    const writeNames = capabilityNamesByTag("write");
    expect(writeNames).toContain("ask");
    expect(writeNames).toContain("status");
    expect(writeNames).not.toContain("agents");
    expect(writeNames).not.toContain("spawn");
    for (const name of writeNames) {
      expect(CLI_CAPABILITY_REGISTRY[name]?.tag).toBe("write");
    }
  });

  it("returns only admin-tagged verbs for tag:admin", () => {
    const adminNames = capabilityNamesByTag("admin");
    expect(adminNames).toContain("spawn");
    expect(adminNames).toContain("roles.fetch");
    expect(adminNames).toContain("test-tool");
    expect(adminNames).not.toContain("agents");
    expect(adminNames).not.toContain("ask");
    for (const name of adminNames) {
      expect(CLI_CAPABILITY_REGISTRY[name]?.tag).toBe("admin");
    }
  });

  it("roles.fetch is tagged admin (fork ruling ii — do NOT retag)", () => {
    const adminNames = capabilityNamesByTag("admin");
    expect(adminNames).toContain("roles.fetch");
    const readNames = capabilityNamesByTag("read");
    expect(readNames).not.toContain("roles.fetch");
  });

  it("all three tag sets partition allCapabilityNames()", () => {
    const all = new Set(allCapabilityNames());
    const read = new Set(capabilityNamesByTag("read"));
    const write = new Set(capabilityNamesByTag("write"));
    const admin = new Set(capabilityNamesByTag("admin"));
    // No verb appears in two tags
    for (const name of all) {
      const tagCount = [read.has(name), write.has(name), admin.has(name)].filter(Boolean).length;
      expect(tagCount).toBe(1);
    }
    // Union covers all
    const union = new Set([...read, ...write, ...admin]);
    expect(union).toEqual(all);
  });
});
