import { describe, it, expect } from "bun:test";
import {
  defineRole,
  defaultSdlcProfile,
  workerRole,
  loadRoleBundle,
} from "../src/index.ts";
import type { SdlcProfile } from "@clobber/shared";

describe("SdlcProfile primitive", () => {
  it("default worker role declares the default 5-phase SDLC on its manifest", () => {
    expect(workerRole.manifest.sdlc).toEqual(defaultSdlcProfile);
  });

  it("default worker role embeds every default-profile phase into its rendered system prompt", () => {
    for (const phase of defaultSdlcProfile.phases) {
      expect(workerRole.systemPrompt).toContain(phase.label);
      expect(workerRole.systemPrompt).toContain(phase.description);
    }
  });

  it("default profile keeps the 5 canonical phases (research → watch-ci) and a final-report CLI hook", () => {
    expect(defaultSdlcProfile.phases.map((p) => p.id)).toEqual([
      "research",
      "failing-test",
      "implement",
      "open-pr",
      "watch-ci",
    ]);
    expect(defaultSdlcProfile.defaultStartingPhase).toBe("research");
    expect(defaultSdlcProfile.reportCliCommand).toBe("report");
  });

  it("custom SdlcProfile renders into the system prompt; default phases drop out", () => {
    const custom: SdlcProfile = {
      phases: [
        {
          id: "spike",
          label: "spike",
          description: "Investigate alternatives without committing to one",
        },
        {
          id: "write-up",
          label: "write-up",
          description: "Summarize findings in a doc and link the trade-offs",
        },
      ],
      defaultStartingPhase: "spike",
    };
    const variant = defineRole({
      root: workerRole.bundleRoot,
      manifest: { ...workerRole.manifest, sdlc: custom },
    });
    expect(variant.systemPrompt).toContain("spike");
    expect(variant.systemPrompt).toContain("write-up");
    expect(variant.systemPrompt).toContain(
      "Investigate alternatives without committing to one",
    );
    expect(variant.systemPrompt).not.toContain("failing-test");
    expect(variant.systemPrompt).not.toContain("watch-ci");
  });

  it("registry exposes a single 'worker' bundle — 'worker-bee' is no longer separate", () => {
    expect(loadRoleBundle("worker")).toBe(workerRole);
    expect(loadRoleBundle("worker-bee")).toBeNull();
  });
});
