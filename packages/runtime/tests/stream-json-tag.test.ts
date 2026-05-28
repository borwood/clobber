import { describe, expect, it } from "bun:test";
import { serializeUserMessage } from "../src/stream-json.ts";

describe("serializeUserMessage with a clobber provenance tag", () => {
  it("leaves the content bare when no tag is passed (composer path)", () => {
    const line = serializeUserMessage("hello");
    const parsed = JSON.parse(line.trim());
    expect(parsed.message.content).toBe("hello");
  });

  it("wraps content in <clobber type=…> when a kind-only tag is passed", () => {
    const line = serializeUserMessage("kick", { kind: "wake-kick" });
    const parsed = JSON.parse(line.trim());
    expect(parsed.message.content).toBe(`<clobber type="wake-kick">kick</clobber>`);
  });

  it("emits attrs in the tag (trigger via=cron)", () => {
    const line = serializeUserMessage("fired", {
      kind: "trigger",
      attrs: { via: "cron" },
    });
    const parsed = JSON.parse(line.trim());
    expect(parsed.message.content).toBe(
      `<clobber type="trigger" via="cron">fired</clobber>`,
    );
  });

  it("emits one JSON line per call (newline-terminated)", () => {
    const line = serializeUserMessage("x", { kind: "live-inject" });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n").filter((s) => s.length > 0).length).toBe(1);
  });
});
