import { describe, it, expect } from "bun:test";
import { CLI_CAPABILITY_REGISTRY } from "@clobber/shared";
import { ALL_ROUTE_CAPABILITY_NAMES } from "@clobber/server/all-route-capabilities.ts";
import { buildCommandRegistry } from "../src/main.ts";

// #554 — three convergence tests that lock the registry against drift:
//   1. Every withAgentAuth name has a registry entry (route-without-entry guarantee).
//   2. Every registry entry is reachable by a real authed route (no orphan entries).
//   3. Every non-local CLI subcommand capability ref resolves in the registry.

describe("CLI capability registry convergence", () => {
  const registryNames = new Set(Object.keys(CLI_CAPABILITY_REGISTRY));
  const routeNames = new Set(ALL_ROUTE_CAPABILITY_NAMES);

  it("every withAgentAuth commandName has a registry entry", () => {
    const missing = [...routeNames].filter((n) => !registryNames.has(n));
    expect(missing).toEqual([]);
  });

  it("no orphan registry entries — every entry is reachable by an authed route", () => {
    const orphans = [...registryNames].filter((n) => !routeNames.has(n));
    expect(orphans).toEqual([]);
  });

  it("every non-local CLI subcommand capability ref resolves in the registry", () => {
    const registry = buildCommandRegistry();
    const dangling: string[] = [];
    for (const cmd of registry.list()) {
      if (cmd.local === true) continue;
      for (const sub of cmd.subcommands ?? []) {
        if (sub.capability === undefined) continue;
        if (!registryNames.has(sub.capability)) {
          dangling.push(`${cmd.name} ${sub.name} → "${sub.capability}"`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });
});
