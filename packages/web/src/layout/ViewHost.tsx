import type { ReactNode } from "react";
import type { ViewId } from "./types.ts";
import { SessionsView } from "../views/SessionsView.tsx";
import { SpawnView } from "../views/SpawnView.tsx";
import { MailboxView } from "../views/MailboxView.tsx";
import { WhiteboardView } from "../views/WhiteboardView.tsx";

// Registry maps ViewId.kind → renderer. Anti-prop-drilling seam: <Pane> never
// touches view-specific props; view shells pull what they need from
// WorkspaceContext. Keep panes location-agnostic so a tab dragged left in
// step 4 looks identical to the same tab on the right by construction.
const REGISTRY: Record<ViewId["kind"], () => ReactNode> = {
  sessions: () => <SessionsView />,
  spawn: () => <SpawnView />,
  mailbox: () => <MailboxView />,
  whiteboard: () => <WhiteboardView />,
};

export function viewLabel(view: ViewId): string {
  switch (view.kind) {
    case "sessions":
      return "Sessions";
    case "spawn":
      return "Spawn";
    case "mailbox":
      return "Mailbox";
    case "whiteboard":
      return "Whiteboard";
  }
}

export function ViewHost(props: { readonly view: ViewId }) {
  return <>{REGISTRY[props.view.kind]()}</>;
}
