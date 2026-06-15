import { useEffect, useRef, useState } from "react";

export const DEFAULT_POLL_MS = 1000;

/**
 * Cursor-based append-on-poll hook — the generalized form of the layout-events
 * cursor loop (#326). On the first tick (cursor undefined) the fetcher is called
 * with no cursor (cold); it returns the initial batch + the starting cursor.
 * Subsequent ticks call the fetcher with the current cursor; only newly
 * appended items are returned, and the cursor advances. The returned array is
 * stable (only grows), so useMemo([lines]) stays valid across ticks.
 *
 * The fetcher must return null when no fetch should happen (e.g. no session id).
 */
export function useAppendPoll<T>(
  fetcher: (cursor: number | undefined) => Promise<{ lines: readonly T[]; cursor: number }> | null,
  deps: readonly unknown[],
  intervalMs: number = DEFAULT_POLL_MS,
): readonly T[] {
  const [lines, setLines] = useState<readonly T[]>([]);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    setLines([]);
    let cursor: number | undefined = undefined;
    let cancelled = false;

    async function tick() {
      const promise = fetcherRef.current(cursor);
      if (promise === null) return;
      const result = await promise;
      if (cancelled) return;
      if (cursor === undefined) {
        setLines(result.lines);
      } else if (result.lines.length > 0) {
        setLines((prev) => [...prev, ...result.lines]);
      }
      cursor = result.cursor;
    }

    void tick();
    const id = setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, deps);

  return lines;
}
