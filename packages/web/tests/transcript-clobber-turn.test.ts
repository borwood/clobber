import { describe, it, expect } from "bun:test";
import { classifyLine } from "../src/transcript-types.ts";

describe("classifyLine: <clobber type=…> provenance tag", () => {
  it("classifies a wake-kick wrapper as kind: clobber-turn with type+attrs+inner", () => {
    const line = {
      type: "user",
      message: {
        role: "user",
        content: `<clobber type="wake-kick">it's been a while — sweep ready issues</clobber>`,
      },
    };
    const c = classifyLine(line);
    expect(c.kind).toBe("clobber-turn");
    if (c.kind !== "clobber-turn") return;
    expect(c.tag.type).toBe("wake-kick");
    expect(c.tag.inner).toBe("it's been a while — sweep ready issues");
    expect(c.tag.attrs).toEqual({});
  });

  it("parses the `via` attribute on a trigger-kind clobber turn", () => {
    const line = {
      type: "user",
      message: {
        role: "user",
        content: `<clobber type="trigger" via="cron">a cron fired: 0 9 * * *</clobber>`,
      },
    };
    const c = classifyLine(line);
    expect(c.kind).toBe("clobber-turn");
    if (c.kind !== "clobber-turn") return;
    expect(c.tag.type).toBe("trigger");
    expect(c.tag.attrs["via"]).toBe("cron");
    expect(c.tag.inner).toBe("a cron fired: 0 9 * * *");
  });

  it("classifies a clobber-turn wrapper carried in a text content block", () => {
    const line = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: `<clobber type="ask-answer">Q: …\nA: yes</clobber>` },
        ],
      },
    };
    const c = classifyLine(line);
    expect(c.kind).toBe("clobber-turn");
    if (c.kind !== "clobber-turn") return;
    expect(c.tag.type).toBe("ask-answer");
  });

  it("leaves a bare (untagged) human-composer turn as kind: user", () => {
    const line = {
      type: "user",
      message: { role: "user", content: "hey can you check the PR" },
    };
    const c = classifyLine(line);
    expect(c.kind).toBe("user");
  });

  it("does NOT misclassify a regular user message that happens to mention the clobber tag", () => {
    const line = {
      type: "user",
      message: {
        role: "user",
        content: "I was reading about the <clobber type=...> wrapper",
      },
    };
    const c = classifyLine(line);
    expect(c.kind).toBe("user");
  });
});
