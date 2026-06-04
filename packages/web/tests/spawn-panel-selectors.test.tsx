import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SpawnPanel } from "../src/components/SpawnPanel.tsx";
import type { SpawnResponse } from "../src/api.ts";

// Capture the last spawn call payload.
let lastSpawnPayload: Record<string, unknown> | null = null;
import { api } from "../src/api.ts";
(api as { spawn: unknown }).spawn = async (req: Record<string, unknown>) => {
  lastSpawnPayload = req;
  return { agent_id: "a1", session_id: "s1", pid: 1 } satisfies SpawnResponse;
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  lastSpawnPayload = null;
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

function reactProps(el: Element): Record<string, unknown> {
  const elAsMap = el as unknown as Record<string, unknown>;
  const fiberKey = Object.keys(elAsMap).find((k) => k.startsWith("__reactFiber"));
  const fiber = fiberKey !== undefined ? elAsMap[fiberKey] : undefined;
  if (fiber === undefined) throw new Error("no React fiber on element");
  return (fiber as { memoizedProps: Record<string, unknown> }).memoizedProps;
}

// Uses native event dispatch — reactProps doesn't reliably attach to select
// elements in happy-dom (React event delegation picks up the bubbled change).
async function changeSelect(select: Element, value: string) {
  (select as HTMLSelectElement).value = value;
  await act(async () => {
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function makePanel(wakePrograms: readonly string[] = []) {
  return createElement(SpawnPanel, {
    workspaceId: "ws-1",
    roleId: "role-1",
    wakePrograms,
    onSpawned: () => {},
  });
}

async function fillAndSubmit(container: HTMLDivElement) {
  const labelInput = container.querySelector("input[type=text]")!;
  const labelProps = reactProps(labelInput);
  await act(async () => {
    (labelProps.onChange as (e: { target: { value: string } }) => void)({ target: { value: "my-label" } });
  });
  const btn = container.querySelector("button") as HTMLButtonElement;
  await act(async () => {
    btn.click();
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("SpawnPanel model + wake-program selectors (#497)", () => {
  it("omits model from payload when effort=default (no model selector changed)", async () => {
    await act(async () => { root.render(makePanel()); });
    await fillAndSubmit(container);
    expect(lastSpawnPayload).not.toBeNull();
    expect(lastSpawnPayload!["model"]).toBeUndefined();
  });

  it("includes model in payload when non-default model is selected", async () => {
    await act(async () => { root.render(makePanel()); });
    const selects = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    // model select is the second select (after effort)
    await changeSelect(selects[1]!, "sonnet");
    await fillAndSubmit(container);
    expect(lastSpawnPayload!["model"]).toBe("sonnet");
  });

  it("sends wake_program='default' when the default choice is selected (first option)", async () => {
    await act(async () => { root.render(makePanel(["worker-main"])); });
    // "default" is the first wake-program choice — leave it at default
    await fillAndSubmit(container);
    // Composer always sends an explicit program; "default" tells the pipeline to
    // resolve the role's declared default_wake_program (#501).
    expect(lastSpawnPayload!["wake_program"]).toBe("default");
  });

  it("includes wake_program in payload when a role-specific program is selected", async () => {
    await act(async () => { root.render(makePanel(["worker-main", "debug"])); });
    const selects = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    // wake_program select is the third select (after effort, model)
    await changeSelect(selects[2]!, "worker-main");
    await fillAndSubmit(container);
    expect(lastSpawnPayload!["wake_program"]).toBe("worker-main");
  });

  it("resets model and wake_program to default after successful spawn", async () => {
    await act(async () => { root.render(makePanel(["worker-main"])); });
    const selects = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    await changeSelect(selects[1]!, "opus");
    await changeSelect(selects[2]!, "worker-main");
    await fillAndSubmit(container);

    // After spawn, both selects should have reset
    const selectsAfter = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    expect(selectsAfter[1]!.value).toBe("default");
    expect(selectsAfter[2]!.value).toBe("default");
  });
});
