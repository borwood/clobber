import { useLayout } from "./provider.tsx";
import { QUICK_ADDS } from "./empty-pane-quick-adds.ts";

interface Props {
  readonly paneId: string;
}

export function EmptyRootPanePlaceholder({ paneId }: Props) {
  const { dispatch } = useLayout();
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-text-subtle">
      <span>Nothing here yet — open a view:</span>
      <div className="flex gap-2">
        {QUICK_ADDS.map((qa) => (
          <button
            key={qa.view.kind}
            type="button"
            onClick={() =>
              dispatch({ kind: "open_view", pane: paneId, view: qa.view })
            }
            className="px-3 py-1 rounded border border-border-strong text-text-soft hover:text-text hover:bg-elevated"
          >
            {qa.label}
          </button>
        ))}
      </div>
    </div>
  );
}
