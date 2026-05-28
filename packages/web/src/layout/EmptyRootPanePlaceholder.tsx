import { useLayout } from "./provider.tsx";
import { QUICK_ADDS } from "./empty-pane-quick-adds.ts";

interface Props {
  readonly paneId: string;
}

export function EmptyRootPanePlaceholder({ paneId }: Props) {
  const { dispatch } = useLayout();
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-zinc-500">
      <span>Nothing here yet — open a view:</span>
      <div className="flex gap-2">
        {QUICK_ADDS.map((qa) => (
          <button
            key={qa.view.kind}
            type="button"
            onClick={() =>
              dispatch({ kind: "open_view", pane: paneId, view: qa.view })
            }
            className="px-3 py-1 rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800"
          >
            {qa.label}
          </button>
        ))}
      </div>
    </div>
  );
}
