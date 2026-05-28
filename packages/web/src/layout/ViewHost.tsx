import type { ReactNode } from "react";
import type { ViewId } from "./types.ts";
import type { SessionSummary } from "../api.ts";
import { SessionsView } from "../views/SessionsView.tsx";
import { SpawnView } from "../views/SpawnView.tsx";
import { MailboxView } from "../views/MailboxView.tsx";
import { WhiteboardView } from "../views/WhiteboardView.tsx";

const REGISTRY: { [K in ViewId["kind"]]: (view: Extract<ViewId, { kind: K }>) => ReactNode } = {
  sessions: () => <SessionsView />,
  spawn: () => <SpawnView />,
  mailbox: (view) => <MailboxView pinnedSessionId={view.sessionId} />,
  whiteboard: () => <WhiteboardView />,
};

export function viewLabel(view: ViewId, sessions?: readonly SessionSummary[]): string {
  switch (view.kind) {
    case "sessions":
      return "Sessions";
    case "spawn":
      return "Spawn";
    case "mailbox":
      if (view.sessionId === undefined) return "Mailbox";
      const s = sessions?.find((x) => x.session_id === view.sessionId);
      return s?.label ?? view.sessionId.slice(0, 8);
    case "whiteboard":
      return "Whiteboard";
  }
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
