import { describe, it, expect } from "bun:test";
import {
  classifyComposerKey,
  type ComposerKeyEvent,
} from "../src/components/composer-key.ts";

function ev(
  key: string,
  mods: Partial<Omit<ComposerKeyEvent, "key">> = {},
): ComposerKeyEvent {
  return {
    key,
    shiftKey: mods.shiftKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
    altKey: mods.altKey ?? false,
  };
}

describe("classifyComposerKey", () => {
  it("Enter alone -> send", () => {
    expect(classifyComposerKey(ev("Enter"), { hasTextSelection: false })).toBe(
      "send",
    );
  });

  it("Shift+Enter -> newline (do not send)", () => {
    expect(
      classifyComposerKey(ev("Enter", { shiftKey: true }), {
        hasTextSelection: false,
      }),
    ).toBe("newline");
  });

  it("Ctrl+Enter -> ignore (no longer sends)", () => {
    expect(
      classifyComposerKey(ev("Enter", { ctrlKey: true }), {
        hasTextSelection: false,
      }),
    ).toBe("ignore");
  });

  it("Cmd+Enter -> ignore (no longer sends)", () => {
    expect(
      classifyComposerKey(ev("Enter", { metaKey: true }), {
        hasTextSelection: false,
      }),
    ).toBe("ignore");
  });

  it("Alt+Enter -> ignore", () => {
    expect(
      classifyComposerKey(ev("Enter", { altKey: true }), {
        hasTextSelection: false,
      }),
    ).toBe("ignore");
  });

  it("Ctrl+C with no selection -> interrupt", () => {
    expect(
      classifyComposerKey(ev("c", { ctrlKey: true }), {
        hasTextSelection: false,
      }),
    ).toBe("interrupt");
  });

  it("Ctrl+C while text is selected -> ignore (let browser copy)", () => {
    expect(
      classifyComposerKey(ev("c", { ctrlKey: true }), {
        hasTextSelection: true,
      }),
    ).toBe("ignore");
  });

  it("Ctrl+Shift+C -> ignore (not the bare interrupt shortcut)", () => {
    expect(
      classifyComposerKey(ev("c", { ctrlKey: true, shiftKey: true }), {
        hasTextSelection: false,
      }),
    ).toBe("ignore");
  });

  it("Cmd+C -> ignore (browser copy on mac)", () => {
    expect(
      classifyComposerKey(ev("c", { metaKey: true }), {
        hasTextSelection: false,
      }),
    ).toBe("ignore");
  });

  it("plain typing key -> ignore", () => {
    expect(classifyComposerKey(ev("a"), { hasTextSelection: false })).toBe(
      "ignore",
    );
  });
});
