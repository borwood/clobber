import { useEffect, useMemo, useState } from "react";
import { GearIcon } from "@phosphor-icons/react/dist/csr/Gear";
import { api, type Workspace } from "./api.ts";
import { WorkspaceTabs } from "./components/WorkspaceTabs.tsx";
import { WorkspaceConfigModal } from "./components/WorkspaceConfigModal.tsx";
import { slugify } from "@clobber/shared";
import { applyWorkspaceTheme, applyLandingTheme } from "./lib/apply-theme.ts";
import { useLocation } from "./hooks/useLocation.ts";
import { useWorkspacePolls } from "./hooks/useWorkspacePolls.ts";
import { buildPath, parseLocation } from "./router.ts";
import { LayoutProvider } from "./layout/provider.tsx";
import { LayoutTree } from "./layout/LayoutTree.tsx";
import { HintBanner } from "./layout/HintBanner.tsx";
import { LayoutMenu } from "./layout/LayoutMenu.tsx";
import {
  WorkspaceProvider,
  type WorkspaceContextValue,
} from "./layout/WorkspaceContext.tsx";

export function App() {
  const { pathname, navigate } = useLocation();
  const { workspaceSlug, sessionId } = parseLocation(pathname);

  const [configOpen, setConfigOpen] = useState(false);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wakingAgents, setWakingAgents] = useState<ReadonlySet<string>>(() => new Set());

  const {
    workspaces,
    liveWorkspaceIds,
    activeWorkspaceId,
    invalidWorkspace,
    assignments,
    sessions,
    offices,
    desks,
    now,
    userNotifications,
    errors: pollErrors,
  } = useWorkspacePolls(workspaceSlug);

  const selectedSession = activeWorkspaceId === null ? null : sessionId;

  useEffect(() => {
    const firstErr = pollErrors.find((e) => e !== undefined);
    if (firstErr !== undefined) setError(firstErr.message);
  }, pollErrors as unknown[]);

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

  // The active workspace's theme applies app-wide; the no-workspace landing uses
  // dark (#369). Depending on the primitives (not the polled object) keeps this
  // from re-firing every poll tick.
  const resolvedWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);

  useEffect(() => {
    document.title =
      resolvedWorkspace === undefined ? "clobber" : `clobber | ${resolvedWorkspace.name}`;
  }, [resolvedWorkspace?.name]);

  const themeMode = resolvedWorkspace?.theme.mode;
  const themePfpSize = resolvedWorkspace?.theme.pfpSize;
  // Serialized so the effect only re-fires when a custom theme's definitions (or
  // a custom accent's color) actually change, not on every poll tick that
  // re-creates the workspace object. Accent serializes too since it may now be a
  // custom-color object, not just a built-in string.
  const themeAccent =
    resolvedWorkspace === undefined ? undefined : JSON.stringify(resolvedWorkspace.theme.accent);
  const themeCustom =
    resolvedWorkspace === undefined ? undefined : JSON.stringify(resolvedWorkspace.theme.custom);
  useEffect(() => {
    if (
      themeMode === undefined ||
      themeAccent === undefined ||
      themeCustom === undefined ||
      themePfpSize === undefined
    ) {
      applyLandingTheme();
      return;
    }
    applyWorkspaceTheme({
      mode: themeMode,
      accent: JSON.parse(themeAccent),
      pfpSize: themePfpSize,
      custom: JSON.parse(themeCustom),
    });
  }, [themeMode, themeAccent, themePfpSize, themeCustom]);

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
      userNotifications,
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
      userNotifications,
    ],
  );

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header className="border-b border-border px-6 py-3 flex items-center gap-4">
        <h1 className="text-xl font-bold tracking-tight">clobber</h1>
        <WorkspaceTabs
          workspaces={workspaces}
          liveWorkspaceIds={liveWorkspaceIds}
          selectedId={activeWorkspaceId}
          onSelect={(slug) => navigate(buildPath(slug, null))}
          onCreated={(ws: Workspace) => navigate(buildPath(slugify(ws.name), null))}
        />
        {activeWorkspaceId !== null && (
          <button
            type="button"
            onClick={() => setConfigOpen(true)}
            className="px-2 py-1 rounded text-text-muted hover:text-text-dim border border-border hover:border-border-strong"
            title="Workspace settings"
            aria-label="Workspace settings"
          >
            <GearIcon size={16} weight="bold" />
          </button>
        )}
        <span className="text-text-subtle text-sm">
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </span>
        <div className="ml-auto flex items-center gap-3">
          {error !== null && (
            <span className="text-danger-text text-xs font-mono">{error}</span>
          )}
        </div>
      </header>

      <LayoutProvider
        key={workspaceSlug}
        workspaceSlug={workspaceSlug}
        workspaceId={activeWorkspaceId}
        deepLinkSessionId={selectedSession}
      >
        <WorkspaceProvider value={workspaceValue}>
          <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <HintBanner />
            {invalidWorkspace && (
              <div className="px-4 py-2 text-sm text-text-muted border-b border-border">
                Workspace not found. Pick one above or create a new workspace.
              </div>
            )}
            <LayoutTree />
          </main>
          {activeWorkspaceId !== null && (
            <div className="fixed top-3 right-6 z-10">
              <LayoutMenu />
            </div>
          )}
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
