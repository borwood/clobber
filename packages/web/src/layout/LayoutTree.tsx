import type { LayoutNode, SplitNode } from "./types.ts";
import { Pane } from "./Pane.tsx";
import { useLayout } from "./provider.tsx";

export function LayoutTree() {
  const { layout } = useLayout();
  return <div className="flex-1 min-h-0 overflow-hidden">{render(layout)}</div>;
}

function render(node: LayoutNode) {
  if (node.kind === "pane") return <Pane node={node} key={node.id} />;
  return <SplitView split={node} />;
}

function SplitView(props: { readonly split: SplitNode }) {
  const { split } = props;
  const flexDir = split.direction === "h" ? "flex-row" : "flex-col";
  return (
    <div className={`flex ${flexDir} h-full w-full`}>
      {split.children.map((child, i) => (
        <div
          key={childKey(child, i)}
          style={{ flexGrow: split.sizes[i] ?? 1, flexBasis: 0, minWidth: 0, minHeight: 0 }}
          className={borderClass(split.direction, i)}
        >
          {render(child)}
        </div>
      ))}
    </div>
  );
}

function childKey(node: LayoutNode, i: number): string {
  return node.kind === "pane" ? node.id : `split-${i}`;
}

function borderClass(dir: "h" | "v", i: number): string {
  if (i === 0) return "";
  return dir === "h" ? "border-l border-zinc-800" : "border-t border-zinc-800";
}
