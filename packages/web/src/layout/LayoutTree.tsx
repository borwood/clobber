import { Fragment, useEffect, useRef, useState } from "react";
import type { LayoutNode, SplitNode } from "./types.ts";
import { Pane } from "./Pane.tsx";
import { Gutter } from "./Gutter.tsx";
import { useLayout } from "./provider.tsx";
import { useWorkspace } from "./WorkspaceContext.tsx";

export function LayoutTree() {
  const { layout } = useLayout();
  return (
    <div className="flex-1 min-h-0 overflow-hidden">{render(layout, [])}</div>
  );
}

function render(node: LayoutNode, path: readonly number[]) {
  if (node.kind === "pane") return <Pane node={node} key={node.id} />;
  return <SplitView split={node} path={path} />;
}

function SplitView(props: { readonly split: SplitNode; readonly path: readonly number[] }) {
  const { split, path } = props;
  const { configOpen } = useWorkspace();
  const ref = useRef<HTMLDivElement | null>(null);
  const [containerPx, setContainerPx] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setContainerPx(split.direction === "h" ? r.width : r.height);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [split.direction]);

  const flexDir = split.direction === "h" ? "flex-row" : "flex-col";
  return (
    <div ref={ref} className={`flex ${flexDir} h-full w-full`}>
      {split.children.map((child, i) => (
        <Fragment key={childKey(child, i)}>
          {i > 0 && (
            <Gutter
              splitPath={path}
              sizes={split.sizes}
              index={i - 1}
              direction={split.direction}
              containerPx={containerPx}
              disabled={configOpen}
            />
          )}
          <div
            style={{ flexGrow: split.sizes[i] ?? 1, flexBasis: 0, minWidth: 0, minHeight: 0 }}
          >
            {render(child, [...path, i])}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function childKey(node: LayoutNode, i: number): string {
  return node.kind === "pane" ? node.id : `split-${i}`;
}
