import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

// CSS grammar grouped by *variant* so every consumer's chrome is frozen at the
// primitive boundary. `pane` is the panel-chrome strip (uppercase tiny on dark,
// h-9, draggable). `workspace` is the page-header strip (font-mono sm, emerald
// accent, navigational). Future strips earn their classes here — consumers
// compose the primitive rather than hand-rolling their own.
const VARIANTS = {
  pane: {
    strip: "flex items-stretch border-b border-zinc-800 h-9 shrink-0",
    base: "px-3 py-1 text-xs uppercase tracking-wider transition-colors cursor-grab focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-500",
    active: "bg-zinc-800 text-zinc-100",
    idle: "bg-transparent text-zinc-400 hover:bg-zinc-900",
  },
  workspace: {
    strip: "flex items-stretch gap-1",
    base: "px-3 py-1 rounded-t text-sm font-mono border-b-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-500",
    active: "text-zinc-100 border-emerald-500",
    idle: "text-zinc-400 border-transparent hover:text-zinc-200 hover:border-zinc-700",
  },
} as const;

type TabsVariant = keyof typeof VARIANTS;

// DragGhost mirrors a pane tab mid-drag, so it needs the pane skin's leaf classes.
export const TAB_BASE_CLASS = VARIANTS.pane.base;
export const TAB_ACTIVE_CLASS = VARIANTS.pane.active;

interface TabDescriptor<T extends string> {
  readonly id: T;
  readonly label: ReactNode;
  readonly badge?: ReactNode;
  readonly closable?: boolean;
}

interface CommonProps<T extends string> {
  readonly tabs: readonly TabDescriptor<T>[];
  readonly activeId: T | null;
  readonly onTabPointerDown?: ((index: number, e: ReactPointerEvent) => void) | undefined;
  readonly onClose?: ((index: number) => void) | undefined;
  readonly ariaLabel?: string;
  readonly variant?: TabsVariant;
  readonly trailing?: ReactNode;
}

interface ButtonTabsProps<T extends string> extends CommonProps<T> {
  readonly as?: "button";
  readonly onSelect: (id: T) => void;
}

interface AnchorTabsProps<T extends string> extends CommonProps<T> {
  readonly as: "a";
  readonly hrefFor: (id: T) => string;
  // Called only on unmodified left-click. Modified/middle/right clicks fall
  // through to the native anchor so the browser opens a new tab/window.
  readonly onNavigate: (id: T) => void;
}

type TabsProps<T extends string> = ButtonTabsProps<T> | AnchorTabsProps<T>;

export function Tabs<T extends string>(props: TabsProps<T>) {
  const { tabs, activeId, onTabPointerDown, onClose, ariaLabel, variant = "pane", trailing } = props;
  const cls = VARIANTS[variant];

  return (
    <div role="tablist" aria-label={ariaLabel} className={cls.strip}>
      {tabs.map((t, i) => {
        const active = t.id === activeId;
        const className = `${cls.base} ${active ? cls.active : cls.idle} group inline-flex items-center`;
        const pointerDown = onTabPointerDown
          ? (e: ReactPointerEvent) => onTabPointerDown(i, e)
          : undefined;
        // Span (not button) to avoid nesting an interactive element inside the
        // tab's <button>/<a>. stopPropagation keeps the parent tab from also
        // receiving select/drag events on close-click.
        const closeButton =
          t.closable === true && onClose !== undefined ? (
            <span
              role="button"
              aria-label="Close tab"
              title="Close tab"
              data-tab-close="true"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onClose(i);
              }}
              className="ml-2 w-4 h-4 inline-flex items-center justify-center rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-700 opacity-0 group-hover:opacity-100 focus:opacity-100 cursor-pointer"
            >
              ×
            </span>
          ) : null;
        const content = (
          <>
            {t.label}
            {t.badge !== undefined && (
              <span className="text-zinc-500 text-xs ml-2">{t.badge}</span>
            )}
            {closeButton}
          </>
        );

        if (props.as === "a") {
          const { hrefFor, onNavigate } = props;
          return (
            <a
              key={t.id}
              role="tab"
              data-tab-index={i}
              className={className}
              href={hrefFor(t.id)}
              aria-current={active ? "page" : undefined}
              onPointerDown={pointerDown}
              onClick={(e) => {
                if (
                  e.button !== 0 ||
                  e.metaKey ||
                  e.ctrlKey ||
                  e.shiftKey ||
                  e.altKey
                )
                  return;
                e.preventDefault();
                onNavigate(t.id);
              }}
            >
              {content}
            </a>
          );
        }

        const { onSelect } = props;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-pane-tab="true"
            data-tab-index={i}
            className={className}
            aria-selected={active}
            onPointerDown={pointerDown}
            onClick={() => onSelect(t.id)}
          >
            {content}
          </button>
        );
      })}
      {trailing !== undefined && (
        <div className="ml-auto flex items-stretch">{trailing}</div>
      )}
    </div>
  );
}
