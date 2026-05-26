import { useEffect, useState } from "react";
import {
  api,
  type DeskCard,
  type OfficeCard,
  type SessionSummary,
  type TranscriptLine,
  type Whiteboard,
  type Workspace,
  type WorkspaceRoleAssignment,
} from "./api.ts";
import { SpawnPanel } from "./components/SpawnPanel.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { WorkspaceTabs } from "./components/WorkspaceTabs.tsx";
import { WorkspaceConfigModal } from "./components/WorkspaceConfigModal.tsx";
import { RolePicker } from "./components/RolePicker.tsx";
import { WhiteboardView } from "./components/WhiteboardView.tsx";
import { ViewSwitcher, type WorkspaceView } from "./components/ViewSwitcher.tsx";
import { MailboxContent } from "./components/MailboxContent.tsx";
import { usePolledResource } from "./hooks/usePolledResource.ts";
import { useLocation } from "./hooks/useLocation.ts";
import { buildPath, parseLocation } from "./router.ts";

const POLL_MS = 1000;
const VIEW_STORAGE_KEY = "clobber:workspace-view";

const EMPTY_WORKSPACES: readonly Workspace[] = [];
const EMPTY_LIVE_IDS: readonly string[] = [];
const EMPTY_ASSIGNMENTS: readonly WorkspaceRoleAssignment[] = [];
const EMPTY_SESSIONS: readonly SessionSummary[] = [];
const EMPTY_OFFICES: readonly OfficeCard[] = [];
const EMPTY_DESKS: readonly DeskCard[] = [];
const EMPTY_TRANSCRIPT: readonly TranscriptLine[] = [];
const EMPTY_WHITEBOARD: Whiteboard = { offices: EMPTY_OFFICES, desks: EMPTY_DESKS };

function readStoredView(): WorkspaceView {
  if (typeof localStorage === "undefined") return "mailbox";
  const raw = localStorage.getItem(VIEW_STORAGE_KEY);
  return raw === "whiteboard" ? "whiteboard" : "mailbox";
}

export function App() {
  const { pathname, navigate } = useLocation();
  const { workspaceId, sessionId } = parseLocation(pathname);

  const [configOpen, setConfigOpen] = useState(false);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<WorkspaceView>(() => readStoredView());
  const [wakingAgents, setWakingAgents] = useState<ReadonlySet<string>>(() => new Set());

  const workspacesPoll = usePolledResource(
    () => api.listWorkspaces(),
    [],
    POLL_MS,
  );
  const workspaces = workspacesPoll.data ?? EMPTY_WORKSPACES;
  const workspacesLoaded = workspacesPoll.data !== undefined;

  const liveIdsPoll = usePolledResource(
    () => api.liveWorkspaceIds(),
    [],
    POLL_MS,
  );
  const liveWorkspaceIds = new Set(liveIdsPoll.data ?? EMPTY_LIVE_IDS);

  // The URL is the source of truth, but a workspace id only becomes active once
  // it's confirmed present. `/w/<bad-id>` resolves to null (empty state) once
  // the workspace list has loaded.
  const workspaceValid = workspaceId !== null && workspaces.some((w) => w.id === workspaceId);
  const activeWorkspaceId = workspaceValid ? workspaceId : null;
  const invalidWorkspace = workspaceId !== null && workspacesLoaded && !workspaceValid;
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

  const whiteboardPoll = usePolledResource<Whiteboard>(
    () =>
      activeWorkspaceId === null || view !== "whiteboard"
        ? Promise.resolve(EMPTY_WHITEBOARD)
        : api.getWhiteboard(activeWorkspaceId),
    [activeWorkspaceId, view],
    POLL_MS,
  );
  const offices = whiteboardPoll.data?.offices ?? EMPTY_OFFICES;
  const desks = whiteboardPoll.data?.desks ?? EMPTY_DESKS;

  const nowPoll = usePolledResource(
    () => Promise.resolve(Date.now()),
    [view],
    POLL_MS,
  );
  const now = nowPoll.data ?? Date.now();

  const transcriptPoll = usePolledResource(
    () =>
      selectedSession === null
        ? Promise.resolve(EMPTY_TRANSCRIPT)
        : api.getTranscript(selectedSession),
    [selectedSession],
    POLL_MS,
  );
  const transcript = transcriptPoll.data ?? EMPTY_TRANSCRIPT;

  useEffect(() => {
    const firstErr = [
      workspacesPoll.error,
      liveIdsPoll.error,
      rolesPoll.error,
      sessionsPoll.error,
      whiteboardPoll.error,
      transcriptPoll.error,
    ].find((e) => e !== undefined);
    if (firstErr !== undefined) setError(firstErr.message);
  }, [
    workspacesPoll.error,
    liveIdsPoll.error,
    rolesPoll.error,
    sessionsPoll.error,
    whiteboardPoll.error,
    transcriptPoll.error,
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

  function persistView(next: WorkspaceView): void {
    setView(next);
    if (typeof localStorage !== "undefined") localStorage.setItem(VIEW_STORAGE_KEY, next);
  }

  function focusSession(id: string): void {
    navigate(buildPath(activeWorkspaceId, id));
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center gap-4">
        <h1 className="text-xl font-bold tracking-tight">clobber</h1>
        <WorkspaceTabs
          workspaces={workspaces}
          liveWorkspaceIds={liveWorkspaceIds}
          selectedId={activeWorkspaceId}
          onSelect={(id) => navigate(buildPath(id, null))}
          onCreated={(ws) => navigate(buildPath(ws.id, null))}
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
          <ViewSwitcher value={view} onChange={persistView} />
          {error !== null && (
            <span className="text-red-400 text-xs font-mono">{error}</span>
          )}
        </div>
      </header>

      <main className="flex-1 grid grid-cols-[18rem_minmax(0,1fr)_22rem] gap-0 overflow-hidden">
        <aside className="border-r border-zinc-800 overflow-y-auto">
          <SessionList
            sessions={sessions}
            selectedId={selectedSession}
            onSelect={focusSession}
            onEnd={async (id) => {
              try {
                await api.endSession(id);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
            onResume={async (id) => {
              try {
                await api.resumeSession(id);
                focusSession(id);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          />
        </aside>

        <section className="flex flex-col overflow-hidden">
          {invalidWorkspace ? (
            <p className="text-sm text-zinc-500 p-4">
              Workspace not found. Pick one above or create a new workspace.
            </p>
          ) : view === "whiteboard" ? (
            <WhiteboardView
              offices={offices}
              desks={desks}
              now={now}
              wakingAgentIds={wakingAgents}
              onOpenSession={(focusId) => {
                persistView("mailbox");
                focusSession(focusId);
              }}
              onWake={async (agentId) => {
                setWakingAgents((prev) => new Set(prev).add(agentId));
                try {
                  const result = await api.wakePersistentAgent(agentId);
                  persistView("mailbox");
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
              }}
            />
          ) : (
            <MailboxContent
              sessions={sessions}
              selectedSession={selectedSession}
              transcript={transcript}
              showSystem={showSystem}
              setShowSystem={setShowSystem}
            />
          )}
        </section>

        <aside className="border-l border-zinc-800 flex flex-col overflow-hidden">
          {activeWorkspaceId === null ? (
            <p className="text-sm text-zinc-500 p-4">
              Create or select a workspace to spawn agents.
            </p>
          ) : (
            <>
              <div className="flex flex-col min-h-0 flex-1 p-4 pb-2 gap-2">
                <h2 className="text-sm uppercase tracking-wider text-zinc-500 shrink-0">role</h2>
                <RolePicker
                  assignments={assignments}
                  selectedRoleId={roleId}
                  onSelect={setRoleId}
                />
              </div>
              <div className="border-t border-zinc-800 p-4 shrink-0 max-h-[60vh] overflow-y-auto">
                <SpawnPanel
                  workspaceId={activeWorkspaceId}
                  roleId={roleId}
                  onSpawned={(s) => focusSession(s.session_id)}
                />
              </div>
            </>
          )}
        </aside>
      </main>
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
