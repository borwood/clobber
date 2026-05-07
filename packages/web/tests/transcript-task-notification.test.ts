import { describe, it, expect } from "bun:test";
import { classifyLine } from "../src/transcript-types.ts";

const SAMPLE = `[SYSTEM NOTIFICATION - NOT USER INPUT]
This is an automated background-task event, NOT a message from the user.
Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.

<task-notification>
<task-id>bvxuarh1t</task-id>
<tool-use-id>toolu_019xCfuKebga2x9vFTidgmyV</tool-use-id>
<output-file>/tmp/foo/bvxuarh1t.output</output-file>
<status>failed</status>
<summary>Background command "Start clobber server with hot reload from server package dir" failed with exit code 144</summary>
</task-notification>`;

describe("classifyLine: task-notification", () => {
  it("classifies a task-notification user line as kind: notification with extracted summary", () => {
    const line = {
      type: "user",
      message: { role: "user", content: SAMPLE },
    };
    const c = classifyLine(line);
    expect(c.kind).toBe("notification");
    if (c.kind !== "notification") return;
    expect(c.summary).toBe(
      'Background command "Start clobber server with hot reload from server package dir" failed with exit code 144',
    );
    expect(c.status).toBe("failed");
  });

  it("classifies a task-notification with content blocks (text first)", () => {
    const line = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: SAMPLE }],
      },
    };
    const c = classifyLine(line);
    expect(c.kind).toBe("notification");
    if (c.kind !== "notification") return;
    expect(c.summary).toContain("failed with exit code 144");
  });

  it("falls back to kind: notification with status-only summary when <summary> tag is missing", () => {
    const text = `[SYSTEM NOTIFICATION - NOT USER INPUT]
<task-notification>
<task-id>x</task-id>
<status>completed</status>
</task-notification>`;
    const line = { type: "user", message: { role: "user", content: text } };
    const c = classifyLine(line);
    expect(c.kind).toBe("notification");
    if (c.kind !== "notification") return;
    expect(c.status).toBe("completed");
  });

  it("does NOT misclassify a regular user message that happens to mention task-notification", () => {
    const line = {
      type: "user",
      message: {
        role: "user",
        content: "I was reading about <task-notification> blocks",
      },
    };
    const c = classifyLine(line);
    expect(c.kind).toBe("user");
  });

  it("classifies a BARE <task-notification> block (no SYSTEM NOTIFICATION header) as kind: notification", () => {
    const text = `<task-notification>
<task-id>bxy1</task-id>
<tool-use-id>toolu_abc</tool-use-id>
<output-file>/tmp/output.txt</output-file>
<status>failed</status>
<summary>Background command "Run tests" failed with exit code 1</summary>
</task-notification>`;
    const line = { type: "user", message: { role: "user", content: text } };
    const c = classifyLine(line);
    expect(c.kind).toBe("notification");
    if (c.kind !== "notification") return;
    expect(c.status).toBe("failed");
    expect(c.summary).toBe('Background command "Run tests" failed with exit code 1');
  });

  it("classifies bare <task-notification> with content blocks (text first)", () => {
    const text = `<task-notification>
<task-id>z</task-id>
<status>completed</status>
<summary>done</summary>
</task-notification>`;
    const line = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    };
    const c = classifyLine(line);
    expect(c.kind).toBe("notification");
    if (c.kind !== "notification") return;
    expect(c.status).toBe("completed");
    expect(c.summary).toBe("done");
  });
});
