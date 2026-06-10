import type { DeskCard, OfficeCard } from "../api.ts";
import { DeskCardView, OfficeCardView } from "./whiteboard-cards.tsx";
import { useSessionCardMenu } from "./useSessionCardMenu.tsx";

// Columns derive from the *container's* width, not the viewport: cards reflow
// into however many rows fit, each at least ~17rem, so a narrow pane on a wide
// screen wraps instead of crushing the cards. (Viewport breakpoints can't see
// the pane width in a multi-pane layout.)
const CARD_GRID = "grid gap-4 grid-cols-[repeat(auto-fill,minmax(17rem,1fr))]";

interface WhiteboardViewProps {
  readonly offices: readonly OfficeCard[];
  readonly desks: readonly DeskCard[];
  readonly now: number;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onOpenInPane: (sessionId: string, x: number, y: number) => void;
  readonly onWake: (agentId: string, wakeProgram: string) => void;
  readonly wakingAgentIds: ReadonlySet<string>;
}

export function WhiteboardView(props: WhiteboardViewProps) {
  const { offices, desks, now, onOpenSession, onOpenInPane, onWake, wakingAgentIds } = props;
  const { openMenuAt, menu } = useSessionCardMenu(onOpenInPane);

  if (offices.length === 0 && desks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <p className="text-text-subtle text-sm">
          No agents in this workspace yet — spawn a worker or install a manager
          to populate the whiteboard.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-6">
      {menu}
      {offices.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-xs uppercase tracking-wider text-text-subtle">
            Offices
          </h2>
          <div className={CARD_GRID}>
            {offices.map((office) => (
              <OfficeCardView
                key={office.agent_id}
                office={office}
                now={now}
                isWaking={wakingAgentIds.has(office.agent_id)}
                onOpenSession={onOpenSession}
                onContextMenu={
                  office.active_session === null
                    ? undefined
                    : (e) => openMenuAt(e, office.active_session!.id)
                }
                onWake={onWake}
              />
            ))}
          </div>
        </section>
      )}
      {desks.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-xs uppercase tracking-wider text-text-subtle">
            Desks at work
          </h2>
          <div className={CARD_GRID}>
            {desks.map((desk) => (
              <DeskCardView
                key={desk.agent_id}
                desk={desk}
                now={now}
                onOpenSession={onOpenSession}
                onContextMenu={(e) => openMenuAt(e, desk.session.id)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
