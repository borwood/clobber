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
import { workerRole, defaultSdlcProfile } from "@clobber/runtime";

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

  it("boot_context_provider (#166) emits a POINTER to the wisdom log, not its body", () => {
    const boot = loadConfig().boot_context_provider;
    expect(boot?.kind).toBe("exec");
    if (boot?.kind !== "exec") throw new Error("expected exec provider");
    const emitted = (boot.args ?? []).join(" ");
    expect(emitted).toContain("brennan-volter/tasks#20");
    // A pointer is one short line surfacing that the log exists — never its contents.
    expect(emitted.length).toBeLessThan(280);
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

  it("manager-triggers.json wires workspace-open (#149) + cron + worker-done (#240) + session-ended (#171) onto the manager role-version", () => {
    const triggers = z.array(RoleTriggerSchema).parse(readExampleJson("manager-triggers.json"));
    const ids = triggers.map(triggerId);
    expect(ids).toContain("workspace-open");
    expect(ids.some((id) => id.startsWith("cron:"))).toBe(true);
    // The work-is-done wake (#240) keys on worker-done; session-ended coexists
    // for crash/kill cleanup — neither supersedes the other.
    expect(ids).toContain("worker-done");
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
