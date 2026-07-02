import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ComposerOptionsMenu } from "../src/components/ComposerOptionsMenu.tsx";
import { EFFORT_LEVELS, MODEL_OPTIONS } from "../src/model-effort-options.ts";

let container: HTMLDivElement;
let root: Root;
let reconfigures: Array<{ model?: string | undefined; effort?: string | undefined }>;

beforeEach(() => {
  reconfigures = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function makeMenu(overrides?: { model?: string | undefined; effort?: string | undefined }) {
  return createElement(ComposerOptionsMenu, {
    richMarkdown: true,
    onToggleRichMarkdown: () => {},
    showDetails: false,
    onToggleShowDetails: () => {},
    canEndSession: true,
    onEndSession: () => {},
    model: overrides?.model,
    effort: overrides?.effort,
    onReconfigure: (change) => {
      reconfigures.push(change);
    },
  });
}

async function openMenu() {
  const trigger = container.querySelector("button[title='Composer options']");
  if (trigger === null) throw new Error("no menu trigger");
  await act(async () => {
    (trigger as HTMLButtonElement).click();
  });
}

async function changeSelect(select: Element, value: string) {
  (select as HTMLSelectElement).value = value;
  await act(async () => {
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function selects(): HTMLSelectElement[] {
  return [...container.querySelectorAll("select")] as HTMLSelectElement[];
}

describe("composer model/effort switching", () => {
  it("renders model + effort pickers with the spawn panel's options, preselected to the session's values", async () => {
    await act(async () => {
      root.render(makeMenu({ model: "opus", effort: "high" }));
    });
    await openMenu();

    const [modelSelect, effortSelect] = selects();
    expect(modelSelect).toBeDefined();
    expect(effortSelect).toBeDefined();
    const modelValues = [...modelSelect!.querySelectorAll("option")].map((o) => o.value);
    const effortValues = [...effortSelect!.querySelectorAll("option")].map((o) => o.value);
    expect(modelValues).toEqual([...MODEL_OPTIONS]);
    expect(effortValues).toEqual([...EFFORT_LEVELS]);
    expect(modelSelect!.value).toBe("opus");
    expect(effortSelect!.value).toBe("high");
  });

  it("fires onReconfigure with only the changed dial", async () => {
    await act(async () => {
      root.render(makeMenu({ model: "opus", effort: "high" }));
    });
    await openMenu();

    const [modelSelect, effortSelect] = selects();
    await changeSelect(modelSelect!, "sonnet");
    expect(reconfigures).toEqual([{ model: "sonnet" }]);

    await changeSelect(effortSelect!, "low");
    expect(reconfigures).toEqual([{ model: "sonnet" }, { effort: "low" }]);
  });

  it("shows an unset placeholder when the session has no recorded value", async () => {
    await act(async () => {
      root.render(makeMenu());
    });
    await openMenu();

    const [modelSelect, effortSelect] = selects();
    expect(modelSelect!.value).toBe("");
    expect(effortSelect!.value).toBe("");
  });
});
