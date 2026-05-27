import type { DeskCard, OfficeCard } from "../api.ts";
import { DeskCardView, OfficeCardView } from "./whiteboard-cards.tsx";

interface WhiteboardViewProps {
  readonly offices: readonly OfficeCard[];
  readonly desks: readonly DeskCard[];
  readonly now: number;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onWake: (agentId: string, wakeProgram: string) => void;
  readonly wakingAgentIds: ReadonlySet<string>;
}

export function WhiteboardView(props: WhiteboardViewProps) {
  const { offices, desks, now, onOpenSession, onWake, wakingAgentIds } = props;

  if (offices.length === 0 && desks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <p className="text-zinc-500 text-sm">
          No agents in this workspace yet — spawn a worker or install a manager
          to populate the whiteboard.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-6">
      {offices.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-xs uppercase tracking-wider text-zinc-500">
            Offices
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {offices.map((office) => (
              <OfficeCardView
                key={office.agent_id}
                office={office}
                now={now}
                isWaking={wakingAgentIds.has(office.agent_id)}
                onOpenSession={onOpenSession}
                onWake={onWake}
              />
            ))}
          </div>
        </section>
      )}
      {desks.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-xs uppercase tracking-wider text-zinc-500">
            Desks at work
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {desks.map((desk) => (
              <DeskCardView
                key={desk.agent_id}
                desk={desk}
                now={now}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
