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

const noSel = { hasTextSelection: false } as const;

describe("classifyComposerKey — send/newline", () => {
  it("Ctrl+Enter -> send", () => {
    expect(classifyComposerKey(ev("Enter", { ctrlKey: true }), noSel)).toBe("send");
  });

  it("Cmd+Enter -> send", () => {
    expect(classifyComposerKey(ev("Enter", { metaKey: true }), noSel)).toBe("send");
  });

  it("Enter alone -> newline (no longer sends)", () => {
    expect(classifyComposerKey(ev("Enter"), noSel)).toBe("newline");
  });

  it("Shift+Enter -> newline", () => {
    expect(classifyComposerKey(ev("Enter", { shiftKey: true }), noSel)).toBe("newline");
  });
});

describe("classifyComposerKey — interrupt", () => {
  it("Ctrl+C with no selection -> interrupt", () => {
    expect(classifyComposerKey(ev("c", { ctrlKey: true }), noSel)).toBe("interrupt");
  });

  it("Ctrl+C while text is selected -> ignore (let browser copy)", () => {
    expect(
      classifyComposerKey(ev("c", { ctrlKey: true }), { hasTextSelection: true }),
    ).toBe("ignore");
  });

  it("Cmd+C -> ignore (browser copy on mac)", () => {
    expect(classifyComposerKey(ev("c", { metaKey: true }), noSel)).toBe("ignore");
  });
});

describe("classifyComposerKey — inline format shortcuts", () => {
  it("Ctrl+B / Cmd+B -> bold", () => {
    expect(classifyComposerKey(ev("b", { ctrlKey: true }), noSel)).toBe("bold");
    expect(classifyComposerKey(ev("b", { metaKey: true }), noSel)).toBe("bold");
  });

  it("Ctrl+I -> italic", () => {
    expect(classifyComposerKey(ev("i", { ctrlKey: true }), noSel)).toBe("italic");
  });

  it("Ctrl+E -> code", () => {
    expect(classifyComposerKey(ev("e", { ctrlKey: true }), noSel)).toBe("code");
  });

  it("Ctrl+Shift+X -> strikethrough (key arrives uppercased)", () => {
    expect(classifyComposerKey(ev("X", { ctrlKey: true, shiftKey: true }), noSel)).toBe(
      "strikethrough",
    );
  });

  it("Ctrl+Alt+B -> ignore (alt disqualifies the shortcut)", () => {
    expect(classifyComposerKey(ev("b", { ctrlKey: true, altKey: true }), noSel)).toBe("ignore");
  });

  it("plain typing key -> ignore", () => {
    expect(classifyComposerKey(ev("b"), noSel)).toBe("ignore");
    expect(classifyComposerKey(ev("a"), noSel)).toBe("ignore");
  });
});
