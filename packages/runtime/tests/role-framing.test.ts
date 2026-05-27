import { describe, it, expect } from "bun:test";
import { managerRole, workerRole } from "../src/index.ts";

// #210 layer A — the role-unique identity header is its own `framing` field,
// no longer fused into the static system prompt monolith.
describe("role framing (layer A)", () => {
  it("manager exposes its identity header as `framing`, lifted out of the static prompt", () => {
    expect(managerRole.framing).toContain("You are the **Manager**");
    expect(managerRole.systemPrompt).not.toContain("You are the **Manager**");
  });

  it("worker exposes its identity header as `framing`, lifted out of the static prompt", () => {
    expect(workerRole.framing).toContain("You are a **Worker**");
    expect(workerRole.systemPrompt).not.toContain("You are a **Worker**");
  });
});
