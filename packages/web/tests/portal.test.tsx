import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Portal } from "../src/components/Portal.tsx";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.getElementById("portal-root")?.remove();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("Portal", () => {
  it("renders children into #portal-root, not into the host container", async () => {
    await act(async () => {
      root.render(
        createElement(Portal, null, createElement("div", { id: "portal-child" }, "hello")),
      );
    });

    const portalRoot = document.getElementById("portal-root");
    expect(portalRoot).not.toBeNull();
    expect(document.getElementById("portal-child")).not.toBeNull();
    expect(container.querySelector("#portal-child")).toBeNull();
  });

  it("creates #portal-root if it does not exist", async () => {
    document.getElementById("portal-root")?.remove();

    await act(async () => {
      root.render(createElement(Portal, null, createElement("span", null, "test")));
    });

    expect(document.getElementById("portal-root")).not.toBeNull();
  });

  it("reuses an existing #portal-root on subsequent renders", async () => {
    await act(async () => {
      root.render(
        createElement(Portal, null, createElement("div", { id: "child-a" }, "a")),
      );
    });

    const portalRoot = document.getElementById("portal-root");
    expect(portalRoot).not.toBeNull();

    await act(async () => {
      root.render(
        createElement(Portal, null, createElement("div", { id: "child-b" }, "b")),
      );
    });

    expect(document.getElementById("portal-root")).toBe(portalRoot);
  });
});
