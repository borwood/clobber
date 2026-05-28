import { useEffect, useMemo, useState } from "react";
import {
  api,
  type DeskCard,
  type OfficeCard,
  type SessionSummary,
  type Whiteboard,
  type WorkspaceRoleAssignment,
  type Workspace,
} from "./api.ts";
import { WorkspaceTabs } from "./components/WorkspaceTabs.tsx";
import { WorkspaceConfigModal } from "./components/WorkspaceConfigModal.tsx";
import { slugify } from "@clobber/shared";
import { usePolledResource } from "./hooks/usePolledResource.ts";
import { useLocation } from "./hooks/useLocation.ts";
import { buildPath, parseLocation } from "./router.ts";
import { LayoutProvider, useLayout } from "./layout/provider.tsx";
import { LayoutTree } from "./layout/LayoutTree.tsx";
import { HintBanner } from "./layout/HintBanner.tsx";
import { defaultLayout } from "./layout/default-layout.ts";
import {
  WorkspaceProvider,
  type WorkspaceContextValue,
} from "./layout/WorkspaceContext.tsx";

const POLL_MS = 1000;

const EMPTY_WORKSPACES: readonly Workspace[] = [];
const EMPTY_LIVE_IDS: readonly string[] = [];
const EMPTY_ASSIGNMENTS: readonly WorkspaceRoleAssignment[] = [];
const EMPTY_SESSIONS: readonly SessionSummary[] = [];
const EMPTY_OFFICES: readonly OfficeCard[] = [];
const EMPTY_DESKS: readonly DeskCard[] = [];
const EMPTY_WHITEBOARD: Whiteboard = { offices: EMPTY_OFFICES, desks: EMPTY_DESKS };

export function App() {
  const { pathname, navigate } = useLocation();
  const { workspaceSlug, sessionId } = parseLocation(pathname);

  const [configOpen, setConfigOpen] = useState(false);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wakingAgents, setWakingAgents] = useState<ReadonlySet<string>>(() => new Set());

  const workspacesPoll = usePolledResource(() => api.listWorkspaces(), [], POLL_MS);
  const workspaces = workspacesPoll.data ?? EMPTY_WORKSPACES;
  const workspacesLoaded = workspacesPoll.data !== undefined;

  const liveIdsPoll = usePolledResource(() => api.liveWorkspaceIds(), [], POLL_MS);
  const liveWorkspaceIds = new Set(liveIdsPoll.data ?? EMPTY_LIVE_IDS);

  const activeWorkspace =
    workspaceSlug === null
      ? undefined
      : workspaces.find((w) => slugify(w.name) === workspaceSlug);
  const activeWorkspaceId = activeWorkspace === undefined ? null : activeWorkspace.id;
  const invalidWorkspace =
    workspaceSlug !== null && workspacesLoaded && activeWorkspace === undefined;
  const selectedSession = activeWorkspaceId === null ? null : sessionId;

  const rolesPoll = usePolledResource(
    () =>
      activeWorkspaceId === null
        ? Promise.resolve(EMPTY_ASSIGNMENTS)
        : api.listWorkspaceRoles(activeWorkspaceId),
    [activeWorkspaceId],
    POLL_MS,
  );
  const assignments = rolesPoll.data ?? EMPTY_ASSIGNMENTS;

  const sessionsPoll = usePolledResource(
    () =>
      activeWorkspaceId === null
        ? Promise.resolve(EMPTY_SESSIONS)
        : api.listSessions(activeWorkspaceId),
    [activeWorkspaceId],
    POLL_MS,
  );
  const sessions = sessionsPoll.data ?? EMPTY_SESSIONS;

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
  const offices = whiteboardPoll.data?.offices ?? EMPTY_OFFICES;
  const desks = whiteboardPoll.data?.desks ?? EMPTY_DESKS;

  const nowPoll = usePolledResource(() => Promise.resolve(Date.now()), [], POLL_MS);
  const now = nowPoll.data ?? Date.now();

  useEffect(() => {
    const firstErr = [
      workspacesPoll.error,
      liveIdsPoll.error,
      rolesPoll.error,
      sessionsPoll.error,
      whiteboardPoll.error,
    ].find((e) => e !== undefined);
    if (firstErr !== undefined) setError(firstErr.message);
  }, [
    workspacesPoll.error,
    liveIdsPoll.error,
    rolesPoll.error,
    sessionsPoll.error,
    whiteboardPoll.error,
  ]);

  useEffect(() => {
    setRoleId((current) => {
      const spawnable = assignments.filter((a) => a.max_concurrent > 0);
      if (current !== null && spawnable.some((a) => a.role.id === current)) return current;
      return spawnable[0]?.role.id ?? null;
    });
  }, [assignments]);

  useEffect(() => {
    if (activeWorkspaceId === null) return;
    void api.notifyWorkspaceOpen(activeWorkspaceId);
  }, [activeWorkspaceId]);

  function focusSession(id: string): void {
    navigate(buildPath(workspaceSlug, id));
  }

  const workspaceValue: WorkspaceContextValue = useMemo(
    () => ({
      activeWorkspaceId,
      invalidWorkspace,
      sessions,
      selectedSession,
      assignments,
      roleId,
      setRoleId,
      offices,
      desks,
      now,
      wakingAgents,
      showSystem,
      setShowSystem,
      configOpen,
      focusSession,
      endSession: async (id) => {
        try {
          await api.endSession(id);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },
      resumeSession: async (id) => {
        try {
          await api.resumeSession(id);
          focusSession(id);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },
      wakeAgent: async (agentId, wakeProgram) => {
        setWakingAgents((prev) => new Set(prev).add(agentId));
        try {
          const result = await api.wakePersistentAgent(agentId, wakeProgram);
          focusSession(result.session_id);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setWakingAgents((prev) => {
            const next = new Set(prev);
            next.delete(agentId);
            return next;
          });
        }
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeWorkspaceId,
      invalidWorkspace,
      sessions,
      selectedSession,
      assignments,
      roleId,
      offices,
      desks,
      now,
      wakingAgents,
      showSystem,
      configOpen,
      workspaceSlug,
    ],
  );

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center gap-4">
        <h1 className="text-xl font-bold tracking-tight">clobber</h1>
        <WorkspaceTabs
          workspaces={workspaces}
          liveWorkspaceIds={liveWorkspaceIds}
          selectedId={activeWorkspaceId}
          onSelect={(slug) => navigate(buildPath(slug, null))}
          onCreated={(ws) => navigate(buildPath(slugify(ws.name), null))}
        />
        {activeWorkspaceId !== null && (
          <button
            type="button"
            onClick={() => setConfigOpen(true)}
            className="px-2 py-1 rounded text-zinc-400 hover:text-zinc-200 border border-zinc-800 hover:border-zinc-700"
            title="Workspace settings"
            aria-label="Workspace settings"
          >
            <span className="text-base leading-none">⚙</span>
          </button>
        )}
        <span className="text-zinc-500 text-sm">
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </span>
        <div className="ml-auto flex items-center gap-3">
          {error !== null && (
            <span className="text-red-400 text-xs font-mono">{error}</span>
          )}
        </div>
      </header>

      <LayoutProvider workspaceSlug={workspaceSlug}>
        <WorkspaceProvider value={workspaceValue}>
          <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <HintBanner />
            <LayoutTree />
          </main>
          <ResetLayoutAffordance />
        </WorkspaceProvider>
      </LayoutProvider>

      {configOpen && activeWorkspaceId !== null && (() => {
        const ws = workspaces.find((w) => w.id === activeWorkspaceId);
        if (ws === undefined) return null;
        return (
          <WorkspaceConfigModal
            workspace={ws}
            onClose={() => setConfigOpen(false)}
            onSaved={() => setConfigOpen(false)}
          />
        );
      })()}
    </div>
  );
}

// v1 escape hatch for "I painted myself into an empty pane" until the v2
// layout menu (add pane / saved layouts) lands. Floats top-right so it
// remains discoverable without competing with workspace tabs for header room.
function ResetLayoutAffordance() {
  const { layout, dispatch } = useLayout();
  return (
    <button
      type="button"
      aria-label="Reset layout"
      title="Reset layout"
      onClick={() => {
        const isDefault =
          JSON.stringify(layout) === JSON.stringify(defaultLayout());
        if (
          !isDefault &&
          !confirm("Reset layout? Your current arrangement will be lost.")
        ) {
          return;
        }
        dispatch({ kind: "reset" });
      }}
      className="fixed top-3 right-6 z-10 px-2 py-1 rounded text-zinc-400 hover:text-zinc-200 border border-zinc-800 hover:border-zinc-700 text-sm leading-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-zinc-500"
    >
      ↺
    </button>
  );
}
