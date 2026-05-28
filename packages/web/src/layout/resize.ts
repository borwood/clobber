import type { LayoutNode, SplitNode } from "./types.ts";

export function applyResize(
  state: LayoutNode,
  path: readonly number[],
  sizes: readonly number[],
  containerPx: number,
  minPx: number,
): LayoutNode {
  return updateSplit(state, path, 0, (split) => {
    if (sizes.length !== split.children.length) {
      throw new Error(
        `resize: size count ${sizes.length} ≠ children count ${split.children.length}`,
      );
    }
    return { ...split, sizes: clampSizes(sizes, minPx / containerPx) };
  });
}

function updateSplit(
  node: LayoutNode,
  path: readonly number[],
  depth: number,
  fn: (s: SplitNode) => SplitNode,
): LayoutNode {
  if (depth === path.length) {
    if (node.kind !== "split") throw new Error("resize: path does not point to a split");
    return fn(node);
  }
  if (node.kind !== "split") throw new Error("resize: path descends through a pane");
  const idx = path[depth]!;
  return {
    ...node,
    children: node.children.map((c, i) =>
      i === idx ? updateSplit(c, path, depth + 1, fn) : c,
    ),
  };
}

function clampSizes(input: readonly number[], minFrac: number): number[] {
  if (input.length * minFrac > 1 + 1e-9) {
    return input.map(() => 1 / input.length);
  }
  let out = input.slice();
  for (let iter = 0; iter < 16; iter++) {
    const below = out.map((s) => s < minFrac - 1e-12);
    if (!below.some(Boolean)) break;
    const deficit = out.reduce((d, s, i) => (below[i] ? d + (minFrac - s) : d), 0);
    const headroom = out.reduce(
      (t, s, i) => (!below[i] ? t + (s - minFrac) : t),
      0,
    );
    if (headroom <= 0) return input.map(() => 1 / input.length);
    out = out.map((s, i) =>
      below[i] ? minFrac : s - (s - minFrac) * (deficit / headroom),
    );
  }
  const sum = out.reduce((a, b) => a + b, 0);
  return out.map((s) => s / sum);
}
