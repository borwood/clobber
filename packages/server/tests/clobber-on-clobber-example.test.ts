import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  CreateWorkspaceRequestSchema,
  RoleTriggerSchema,
  triggerId,
  type CreateWorkspaceRequest,
} from "@clobber/shared";
import {
  workerRole,
  managerRole,
  defaultSdlcProfile,
  enumerateDefaultSeeds,
} from "@clobber/runtime";

// examples/ lives at the repo root; this test file is packages/server/tests/.
const EXAMPLE_DIR = join(import.meta.dir, "../../../examples/clobber-on-clobber");

function readExampleJson(file: string): unknown {
  return JSON.parse(readFileSync(join(EXAMPLE_DIR, file), "utf8"));
}

function loadConfig(): CreateWorkspaceRequest {
  return CreateWorkspaceRequestSchema.parse(readExampleJson("workspace.config.json"));
}

describe("examples/clobber-on-clobber — dogfood workspace config (#150)", () => {
  it("workspace.config.json validates against the engine's workspace-config seam (#126)", () => {
    const parsed = CreateWorkspaceRequestSchema.safeParse(
      readExampleJson("workspace.config.json"),
    );
    expect(parsed.success).toBe(true);
  });

  it("final_report_callback (#196) is noop — the DB is the record, the manager triages", () => {
    // Blanket GH-issue filing per worker finish was rejected as noisy (#196):
    // reports already persist to agent_status_log, #171 wakes the manager with
    // each one, and it files a ticket / captures wisdom only when actionable.
    const cb = loadConfig().final_report_callback;
    expect(cb?.kind).toBe("noop");
  });

  it("the wisdom-pointer is now a role-scoped seed reaching the manager alone, not a workspace-global provider (#211)", () => {
    // The boot_context_provider field is retired; the wisdom pointer migrated
    // to the manager-role seed `wisdom-pointer`. The worker must not reference
    // it — that global seeding was the #166 mis-shape this fixes.
    expect(loadConfig()).not.toHaveProperty("boot_context_provider");

    const managerRefs = managerRole.manifest.seedRefs ?? [];
    const workerRefs = workerRole.manifest.seedRefs ?? [];
    expect(managerRefs).toContainEqual({ name: "wisdom-pointer", enabled: true });
    expect(workerRefs.some((r) => r.name === "wisdom-pointer")).toBe(false);

    // The pointer is one short line surfacing that the log exists, never its body.
    const seed = enumerateDefaultSeeds().find((s) => s.name === "wisdom-pointer")!;
    if (seed.definition.kind !== "static") throw new Error("expected static seed");
    expect(seed.definition.text).toContain("brennan-volter/tasks#20");
    expect(seed.definition.text.length).toBeLessThan(280);
  });

  it("manager_skill_policy (#148) allows self-grant + lists clobber-pm", () => {
    const policy = loadConfig().manager_skill_policy;
    expect(policy?.allow_self_grant).toBe(true);
    expect(policy?.allowed_skills).toContain("clobber-pm");
  });

  it("trigger_overrides (#146) disables nothing — the manager's triggers stay live", () => {
    expect(loadConfig().trigger_overrides).toEqual({});
  });

  it("wake_prompt is clobber-shaped — it dispatches workers via /assignment", () => {
    const wake = loadConfig().wake_prompt;
    expect(wake).toBeDefined();
    expect(wake).toContain("/assignment");
  });

  it("manager-triggers.json wires workspace-open (#149) + cron + session-ended (#171) onto the manager role-version", () => {
    const triggers = z.array(RoleTriggerSchema).parse(readExampleJson("manager-triggers.json"));
    const ids = triggers.map(triggerId);
    expect(ids).toContain("workspace-open");
    expect(ids.some((id) => id.startsWith("cron:"))).toBe(true);
    expect(ids).toContain("session-ended");
  });

  it("worker SDLC profile (#124) is the shipped research→…→watch-ci default", () => {
    expect(workerRole.manifest.sdlc).toEqual(defaultSdlcProfile);
    expect(defaultSdlcProfile.phases.map((p) => p.id)).toEqual([
      "research",
      "failing-test",
      "implement",
      "open-pr",
      "watch-ci",
    ]);
  });
});
