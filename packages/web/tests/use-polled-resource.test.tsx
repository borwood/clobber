import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePolledResource } from "../src/hooks/usePolledResource.ts";

interface ProbeProps<T> {
  readonly fetcher: () => Promise<T>;
  readonly deps: readonly unknown[];
  readonly intervalMs: number;
  readonly onState: (s: { data: T | undefined; error: Error | undefined }) => void;
}

function Probe<T>({ fetcher, deps, intervalMs, onState }: ProbeProps<T>) {
  const state = usePolledResource(fetcher, deps, intervalMs);
  onState(state);
  return null;
}

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

async function flushTick(ms = 60) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

describe("usePolledResource", () => {
  it("hydrates data on the initial tick (happy path)", async () => {
    let last: { data: number | undefined; error: Error | undefined } = {
      data: undefined,
      error: undefined,
    };
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return 42;
    };

    await act(async () => {
      root.render(
        <Probe
          fetcher={fetcher}
          deps={[]}
          intervalMs={20}
          onState={(s) => {
            last = s;
          }}
        />,
      );
    });
    await flushTick(5);

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(last.data).toBe(42);
    expect(last.error).toBeUndefined();

    await act(async () => {
      root.unmount();
    });
  });

  it("surfaces an Error on rejection (error path)", async () => {
    let last: { data: string | undefined; error: Error | undefined } = {
      data: undefined,
      error: undefined,
    };
    const fetcher = async () => {
      throw new Error("boom");
    };

    await act(async () => {
      root.render(
        <Probe
          fetcher={fetcher}
          deps={[]}
          intervalMs={20}
          onState={(s) => {
            last = s;
          }}
        />,
      );
    });
    await flushTick(5);

    expect(last.data).toBeUndefined();
    expect(last.error).toBeInstanceOf(Error);
    expect(last.error?.message).toBe("boom");

    await act(async () => {
      root.unmount();
    });
  });

  it("re-polls on the configured interval and reflects new data", async () => {
    let last: { data: number | undefined; error: Error | undefined } = {
      data: undefined,
      error: undefined,
    };
    let n = 0;
    const fetcher = async () => {
      n += 1;
      return n;
    };

    await act(async () => {
      root.render(
        <Probe
          fetcher={fetcher}
          deps={[]}
          intervalMs={15}
          onState={(s) => {
            last = s;
          }}
        />,
      );
    });
    await flushTick(80);

    expect(n).toBeGreaterThanOrEqual(3);
    expect(last.data).toBeGreaterThanOrEqual(3);
    expect(last.error).toBeUndefined();

    await act(async () => {
      root.unmount();
    });
  });

  it("stops calling setState after unmount (no cancelled-after-unmount writes)", async () => {
    let renders = 0;
    let resolvePending: ((v: string) => void) | undefined;
    const pending = new Promise<string>((res) => {
      resolvePending = res;
    });
    const fetcher = async () => pending;

    await act(async () => {
      root.render(
        <Probe
          fetcher={fetcher}
          deps={[]}
          intervalMs={20}
          onState={() => {
            renders += 1;
          }}
        />,
      );
    });
    const rendersBeforeUnmount = renders;

    await act(async () => {
      root.unmount();
    });

    resolvePending!("late");
    await new Promise((r) => setTimeout(r, 30));

    expect(renders).toBe(rendersBeforeUnmount);
  });
});
