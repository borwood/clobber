import { useEffect, useState } from "react";

export const DEFAULT_POLL_MS = 1000;

export interface PolledResource<T> {
  readonly data: T | undefined;
  readonly error: Error | undefined;
}

export function usePolledResource<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[],
  intervalMs: number = DEFAULT_POLL_MS,
): PolledResource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const next = await fetcher();
        if (cancelled) return;
        setData(next);
        setError(undefined);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      }
    }
    void tick();
    const id = setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, deps);

  return { data, error };
}
