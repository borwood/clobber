import { useMemo } from "react";
import {
  api,
  type DeskCard,
  type OfficeCard,
  type SessionSummary,
  type Whiteboard,
  type WorkspaceRoleAssignment,
  type Workspace,
} from "../api.ts";
import { slugify } from "@clobber/shared";
import { usePolledResource } from "./usePolledResource.ts";

const POLL_MS = 1000;

const EMPTY_WORKSPACES: readonly Workspace[] = [];
const EMPTY_LIVE_IDS: readonly string[] = [];
const EMPTY_ASSIGNMENTS: readonly WorkspaceRoleAssignment[] = [];
const EMPTY_SESSIONS: readonly SessionSummary[] = [];
const EMPTY_OFFICES: readonly OfficeCard[] = [];
const EMPTY_DESKS: readonly DeskCard[] = [];
const EMPTY_WHITEBOARD: Whiteboard = { offices: EMPTY_OFFICES, desks: EMPTY_DESKS };

export interface WorkspacePolls {
  readonly workspaces: readonly Workspace[];
  readonly workspacesLoaded: boolean;
  readonly liveWorkspaceIds: ReadonlySet<string>;
  readonly activeWorkspaceId: string | null;
  readonly invalidWorkspace: boolean;
  readonly assignments: readonly WorkspaceRoleAssignment[];
  readonly sessions: readonly SessionSummary[];
  readonly offices: readonly OfficeCard[];
  readonly desks: readonly DeskCard[];
  readonly now: number;
  readonly userNotificationCount: number;
  readonly userNotificationHasHigh: boolean;
  readonly errors: ReadonlyArray<Error | undefined>;
}

export function useWorkspacePolls(workspaceSlug: string | null): WorkspacePolls {
  const workspacesPoll = usePolledResource(() => api.listWorkspaces(), [], POLL_MS);
  const workspaces = workspacesPoll.data ?? EMPTY_WORKSPACES;
  const workspacesLoaded = workspacesPoll.data !== undefined;

  const liveIdsPoll = usePolledResource(() => api.liveWorkspaceIds(), [], POLL_MS);
  const liveWorkspaceIds = new Set(liveIdsPoll.data ?? EMPTY_LIVE_IDS);

  const resolvedWorkspace =
    workspaceSlug === null ? undefined : workspaces.find((w) => slugify(w.name) === workspaceSlug);
  const activeWorkspaceId = resolvedWorkspace?.id ?? null;
  const invalidWorkspace =
    workspaceSlug !== null && workspacesLoaded && resolvedWorkspace === undefined;

  const rolesPoll = usePolledResource(
    () =>
      activeWorkspaceId === null
        ? Promise.resolve(EMPTY_ASSIGNMENTS)
        : api.listWorkspaceRoles(activeWorkspaceId),
    [activeWorkspaceId],
    POLL_MS,
  );

  const sessionsPoll = usePolledResource(
    () =>
      activeWorkspaceId === null
        ? Promise.resolve(EMPTY_SESSIONS)
        : api.listSessions(activeWorkspaceId),
    [activeWorkspaceId],
    POLL_MS,
  );

  // With panes, mailbox and whiteboard can both be visible at once, so the
  // whiteboard poll runs whenever a workspace is active rather than gating on
  // the (now-removed) global view selector.
  const whiteboardPoll = usePolledResource<Whiteboard>(
    () =>
      activeWorkspaceId === null
        ? Promise.resolve(EMPTY_WHITEBOARD)
        : api.getWhiteboard(activeWorkspaceId),
    [activeWorkspaceId],
    POLL_MS,
  );

  const nowPoll = usePolledResource(() => Promise.resolve(Date.now()), [], POLL_MS);

  const EMPTY_NOTIFICATIONS = useMemo(() => ({ notifications: [] as const }), []);
  const notifPoll = usePolledResource(
    () =>
      activeWorkspaceId === null
        ? Promise.resolve(EMPTY_NOTIFICATIONS)
        : api.listUserNotifications(),
    [activeWorkspaceId],
    POLL_MS,
  );
  const notifData = notifPoll.data?.notifications ?? [];

  return {
    workspaces,
    workspacesLoaded,
    liveWorkspaceIds,
    activeWorkspaceId,
    invalidWorkspace,
    assignments: rolesPoll.data ?? EMPTY_ASSIGNMENTS,
    sessions: sessionsPoll.data ?? EMPTY_SESSIONS,
    offices: whiteboardPoll.data?.offices ?? EMPTY_OFFICES,
    desks: whiteboardPoll.data?.desks ?? EMPTY_DESKS,
    now: nowPoll.data ?? Date.now(),
    userNotificationCount: notifData.length,
    userNotificationHasHigh: notifData.some((n) => n.priority === "high"),
    errors: [
      workspacesPoll.error,
      liveIdsPoll.error,
      rolesPoll.error,
      sessionsPoll.error,
      whiteboardPoll.error,
    ],
  };
}
