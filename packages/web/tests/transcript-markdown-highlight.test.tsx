import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "../src/components/Markdown.tsx";

describe("Markdown: syntax-highlighted code blocks (#43)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterAll(() => {
    GlobalRegistrator.unregister();
  });

  it("highlights a fenced code block when a language is given", () => {
    const text = "```js\nconst x = 1;\n```";
    act(() => {
      root.render(<Markdown text={text} />);
    });
    // rehype-highlight tags highlighted code with the `hljs` class and emits
    // token spans (e.g. hljs-keyword for `const`).
    expect(container.querySelector("code.hljs")).not.toBeNull();
    expect(container.querySelector(".hljs-keyword")).not.toBeNull();
  });

  it("renders inline markdown (bold, links) as elements, not literal markup", () => {
    act(() => {
      root.render(<Markdown text="**bold** and [a link](https://example.com)" />);
    });
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com",
    );
    expect(container.textContent).not.toContain("**bold**");
  });
});
