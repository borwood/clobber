import type { PaneNode } from "./types.ts";
import { Tabs } from "./Tabs.tsx";
import { ViewHost, viewLabel } from "./ViewHost.tsx";
import { useLayout } from "./provider.tsx";

// Container chrome: a pane is a column with a tab strip on top and a body
// that owns its own scroll. `flex-1 min-h-0 overflow-hidden` keeps the body
// constrained to the pane's slot inside the split — without min-h-0, flex
// children expand to content and break the layout.
const PANE_CLASS = "flex flex-col min-h-0 min-w-0 overflow-hidden";
const BODY_CLASS = "flex-1 min-h-0 overflow-hidden flex flex-col";

export function Pane(props: { readonly node: PaneNode }) {
  const { node } = props;
  const { dispatch } = useLayout();
  const active = node.activeIndex === null ? null : node.views[node.activeIndex]!;

  const tabs = node.views.map((v, i) => ({
    id: String(i),
    label: viewLabel(v),
  }));

  return (
    <div className={PANE_CLASS} data-pane="true" data-pane-id={node.id}>
      {tabs.length > 0 && (
        <Tabs
          tabs={tabs}
          activeId={node.activeIndex === null ? null : String(node.activeIndex)}
          onSelect={(id) =>
            dispatch({ kind: "select_tab", pane: node.id, index: Number(id) })
          }
          ariaLabel={`pane ${node.id}`}
        />
      )}
      <div className={BODY_CLASS}>
        {active === null ? (
          <div className="flex-1 flex items-center justify-center text-xs text-zinc-600">
            drop a tab here
          </div>
        ) : (
          <ViewHost view={active} />
        )}
      </div>
    </div>
  );
}
