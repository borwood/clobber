export type WorkspaceView = "mailbox" | "whiteboard";

interface ViewSwitcherProps {
  readonly value: WorkspaceView;
  readonly onChange: (next: WorkspaceView) => void;
}

const VIEWS: readonly { id: WorkspaceView; label: string }[] = [
  { id: "mailbox", label: "Mailbox" },
  { id: "whiteboard", label: "Whiteboard" },
];

export function ViewSwitcher(props: ViewSwitcherProps) {
  const { value, onChange } = props;
  return (
    <div
      role="tablist"
      aria-label="content view"
      className="inline-flex rounded-md border border-zinc-800 overflow-hidden"
    >
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          role="tab"
          aria-selected={value === v.id}
          onClick={() => onChange(v.id)}
          className={`px-3 py-1 text-xs uppercase tracking-wider transition-colors ${
            value === v.id
              ? "bg-zinc-800 text-zinc-100"
              : "bg-transparent text-zinc-400 hover:bg-zinc-900"
          }`}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}
