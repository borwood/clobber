import type { ReactNode } from "react";
import type { ViewId } from "./types.ts";
import type { SessionSummary } from "../api.ts";
import { SessionsView } from "../views/SessionsView.tsx";
import { SpawnView } from "../views/SpawnView.tsx";
import { MailboxView } from "../views/MailboxView.tsx";
import { WhiteboardView } from "../views/WhiteboardView.tsx";
import { InboxView } from "../views/InboxView.tsx";
import { ActivityDot } from "../components/ActivityDot.tsx";
import { statusDot } from "../components/state-tones.ts";

const REGISTRY: { [K in ViewId["kind"]]: (view: Extract<ViewId, { kind: K }>) => ReactNode } = {
  sessions: () => <SessionsView />,
  spawn: () => <SpawnView />,
  mailbox: (view) => <MailboxView sessionId={view.sessionId} />,
  whiteboard: () => <WhiteboardView />,
  inbox: () => <InboxView />,
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
    case "inbox":
      return "Inbox";
  }
}

export interface TabLabelContext {
  readonly sessions?: readonly SessionSummary[];
  readonly inboxUnreadCount?: number;
  readonly inboxHasHigh?: boolean;
}

// Tab label as a node: mailbox tabs get a live agent-status dot; inbox tabs
// get an unread/high-prio dot. Other kinds are plain text.
export function tabLabel(view: ViewId, ctx: TabLabelContext = {}): ReactNode {
  const text = viewLabel(view, ctx.sessions);
  if (view.kind === "mailbox") {
    const dot = statusDot(ctx.sessions?.find((s) => s.session_id === view.sessionId));
    return (
      <span className="inline-flex items-center gap-1.5">
        <ActivityDot busy={dot.busy} intentDot={dot.dot} hollow={dot.hollow} />
        {text}
      </span>
    );
  }
  if (view.kind === "inbox" && (ctx.inboxUnreadCount ?? 0) > 0) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span
          className={[
            "inline-block size-2 rounded-full",
            ctx.inboxHasHigh === true ? "bg-danger" : "bg-accent",
          ].join(" ")}
          aria-hidden
        />
        {text}
      </span>
    );
  }
  return text;
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
    case "inbox":
      return <>{REGISTRY.inbox(view)}</>;
  }
}
