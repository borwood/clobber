import { describe, it, expect } from "bun:test";
import {
  computeFormat,
  type ChangeSpec,
  type MarkdownFormat,
  type SelectionRange,
} from "../src/components/markdown-format.ts";

// Apply CM-shaped changes to a plain string so we can assert on the resulting
// document the same way CodeMirror would produce it.
function applyChanges(doc: string, changes: readonly ChangeSpec[]): string {
  let result = "";
  let cursor = 0;
  for (const c of [...changes].sort((a, b) => a.from - b.from)) {
    result += doc.slice(cursor, c.from) + c.insert;
    cursor = c.to;
  }
  return result + doc.slice(cursor);
}

function run(doc: string, sel: SelectionRange, format: MarkdownFormat) {
  const change = computeFormat(doc, sel, format);
  return { doc: applyChanges(doc, change.changes), selection: change.selection };
}

describe("computeFormat — inline wrap", () => {
  it("wraps a selection in bold markers and keeps the text selected", () => {
    const r = run("the word here", { from: 4, to: 8 }, "bold");
    expect(r.doc).toBe("the **word** here");
    expect(r.selection).toEqual({ from: 6, to: 10 });
  });

  it("wraps a selection in italic markers", () => {
    const r = run("the word here", { from: 4, to: 8 }, "italic");
    expect(r.doc).toBe("the *word* here");
    expect(r.selection).toEqual({ from: 5, to: 9 });
  });

  it("wraps a selection in inline code backticks", () => {
    const r = run("run npm now", { from: 4, to: 7 }, "code");
    expect(r.doc).toBe("run `npm` now");
  });

  it("wraps a selection in strikethrough markers", () => {
    const r = run("the word here", { from: 4, to: 8 }, "strikethrough");
    expect(r.doc).toBe("the ~~word~~ here");
  });

  it("inserts an empty marker pair and parks the caret inside on empty selection", () => {
    const r = run("a b", { from: 2, to: 2 }, "bold");
    expect(r.doc).toBe("a ****b");
    expect(r.selection).toEqual({ from: 4, to: 4 });
  });
});

describe("computeFormat — inline toggle off", () => {
  it("removes markers sitting just outside the selection", () => {
    const r = run("the **word** here", { from: 6, to: 10 }, "bold");
    expect(r.doc).toBe("the word here");
    expect(r.selection).toEqual({ from: 4, to: 8 });
  });

  it("removes markers contained within the selection", () => {
    const r = run("the **word** here", { from: 4, to: 12 }, "bold");
    expect(r.doc).toBe("the word here");
    expect(r.selection).toEqual({ from: 4, to: 8 });
  });
});

describe("computeFormat — line prefixes", () => {
  it("adds a heading prefix to the current line", () => {
    const r = run("title\nbody", { from: 1, to: 1 }, "heading");
    expect(r.doc).toBe("# title\nbody");
    expect(r.selection).toEqual({ from: 3, to: 3 });
  });

  it("toggles the heading prefix back off", () => {
    const r = run("# title\nbody", { from: 3, to: 3 }, "heading");
    expect(r.doc).toBe("title\nbody");
    expect(r.selection).toEqual({ from: 1, to: 1 });
  });

  it("prefixes every line a multi-line selection spans", () => {
    const r = run("one\ntwo\nthree", { from: 0, to: 13 }, "bullet");
    expect(r.doc).toBe("- one\n- two\n- three");
  });

  it("removes the prefix from all lines when every line already has it", () => {
    const r = run("- one\n- two", { from: 0, to: 11 }, "bullet");
    expect(r.doc).toBe("one\ntwo");
  });

  it("adds the prefix to lines that lack it when the selection is mixed", () => {
    const r = run("- one\ntwo", { from: 0, to: 9 }, "bullet");
    expect(r.doc).toBe("- one\n- two");
  });

  it("supports ordered-list and quote prefixes", () => {
    expect(run("item", { from: 0, to: 0 }, "ordered").doc).toBe("1. item");
    expect(run("note", { from: 0, to: 0 }, "quote").doc).toBe("> note");
  });

  it("clamps a caret inside a removed prefix to the line start", () => {
    const r = run("# title", { from: 1, to: 1 }, "heading");
    expect(r.doc).toBe("title");
    expect(r.selection).toEqual({ from: 0, to: 0 });
  });
});
