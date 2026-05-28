import type { ReactNode } from "react";

// CSS grammar lifted verbatim from the late ViewSwitcher.tsx so every pane,
// and any future tab strip, looks identical. Pane authors get all of this for
// free; per-pane re-implementation is structurally impossible.
export const TAB_STRIP_CLASS =
  "flex items-stretch border-b border-zinc-800 h-9 shrink-0";
export const TAB_BASE_CLASS =
  "px-3 py-1 text-xs uppercase tracking-wider transition-colors cursor-grab focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-500";
export const TAB_ACTIVE_CLASS = "bg-zinc-800 text-zinc-100";
export const TAB_IDLE_CLASS = "bg-transparent text-zinc-400 hover:bg-zinc-900";

interface TabDescriptor<T extends string> {
  readonly id: T;
  readonly label: ReactNode;
  readonly badge?: ReactNode;
}

interface TabsProps<T extends string> {
  readonly tabs: readonly TabDescriptor<T>[];
  readonly activeId: T | null;
  readonly onSelect: (id: T) => void;
  readonly ariaLabel?: string;
}

export function Tabs<T extends string>(props: TabsProps<T>) {
  const { tabs, activeId, onSelect, ariaLabel } = props;
  return (
    <div role="tablist" aria-label={ariaLabel} className={TAB_STRIP_CLASS}>
      {tabs.map((t) => {
        const active = t.id === activeId;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-pane-tab="true"
            aria-selected={active}
            onClick={() => onSelect(t.id)}
            className={`${TAB_BASE_CLASS} ${active ? TAB_ACTIVE_CLASS : TAB_IDLE_CLASS}`}
          >
            {t.label}
            {t.badge !== undefined && (
              <span className="text-zinc-500 text-xs ml-2">{t.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
