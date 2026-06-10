import type { ReactNode } from "react";
import type { ViewId } from "./types.ts";
import type { SessionSummary } from "../api.ts";
import { SessionsView } from "../views/SessionsView.tsx";
import { SpawnView } from "../views/SpawnView.tsx";
import { MailboxView } from "../views/MailboxView.tsx";
import { WhiteboardView } from "../views/WhiteboardView.tsx";
import { ActivityDot } from "../components/ActivityDot.tsx";
import { statusDot } from "../components/state-tones.ts";

const REGISTRY: { [K in ViewId["kind"]]: (view: Extract<ViewId, { kind: K }>) => ReactNode } = {
  sessions: () => <SessionsView />,
  spawn: () => <SpawnView />,
  mailbox: (view) => <MailboxView sessionId={view.sessionId} />,
  whiteboard: () => <WhiteboardView />,
};

export function viewLabel(view: ViewId, sessions?: readonly SessionSummary[]): string {
  switch (view.kind) {
    case "sessions":
      return "Sessions";
    case "spawn":
      return "Spawn";
    case "mailbox": {
      const s = sessions?.find((x) => x.session_id === view.sessionId);
      return s?.label ?? view.sessionId.slice(0, 8);
    }
    case "whiteboard":
      return "Whiteboard";
  }
}

// Tab label as a node: mailbox (agent transcript) tabs get a live status dot
// prepended so the tab itself signals the agent's activity. Other kinds are
// plain text. Re-derives from `sessions` on every poll, so the dot stays live.
export function tabLabel(view: ViewId, sessions?: readonly SessionSummary[]): ReactNode {
  const text = viewLabel(view, sessions);
  if (view.kind !== "mailbox") return text;
  const dot = statusDot(sessions?.find((s) => s.session_id === view.sessionId));
  return (
    <span className="inline-flex items-center gap-1.5">
      <ActivityDot busy={dot.busy} intentDot={dot.dot} hollow={dot.hollow} />
      {text}
    </span>
  );
}

export function ViewHost(props: { readonly view: ViewId }) {
  const view = props.view;
  // Dispatch on kind so TS narrows `view` to the matching variant for the renderer.
  switch (view.kind) {
    case "sessions":
      return <>{REGISTRY.sessions(view)}</>;
    case "spawn":
      return <>{REGISTRY.spawn(view)}</>;
    case "mailbox":
      return <>{REGISTRY.mailbox(view)}</>;
    case "whiteboard":
      return <>{REGISTRY.whiteboard(view)}</>;
  }
}
