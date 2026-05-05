import { useEffect, useState } from "react";
import {
  api,
  type SessionSummary,
  type TranscriptLine,
  type Workspace,
  type WorkspaceRoleAssignment,
} from "./api.ts";
import { SpawnPanel } from "./components/SpawnPanel.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { SessionHeader } from "./components/SessionHeader.tsx";
import { TranscriptViewer } from "./components/TranscriptViewer.tsx";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher.tsx";
import { RolePicker } from "./components/RolePicker.tsx";
import { PromptComposer } from "./components/PromptComposer.tsx";
import { AskWidget } from "./components/AskWidget.tsx";

const POLL_MS = 1000;

export function App() {
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<readonly WorkspaceRoleAssignment[]>([]);
  const [roleId, setRoleId] = useState<string | null>(null);

  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<readonly TranscriptLine[]>([]);
  const [showSystem, setShowSystem] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const next = await api.listWorkspaces();
        if (cancelled) return;
        setWorkspaces(next);
        setWorkspaceId((current) => {
          if (current !== null && next.some((w) => w.id === current)) return current;
          return next[0]?.id ?? null;
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (workspaceId === null) {
      setAssignments([]);
      setRoleId(null);
      return;
    }
    let cancelled = false;
    async function tick() {
      try {
        const next = await api.listWorkspaceRoles(workspaceId!);
        if (cancelled) return;
        setAssignments(next);
        setRoleId((current) => {
          const spawnable = next.filter((a) => a.max_concurrent > 0);
          if (current !== null && spawnable.some((a) => a.role.id === current)) return current;
          return spawnable[0]?.role.id ?? null;
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [workspaceId]);

  useEffect(() => {
    setSessions([]);
    setSelectedSession(null);
    if (workspaceId === null) return;
    let cancelled = false;
    async function tick() {
      try {
        const next = await api.listSessions(workspaceId!);
        if (!cancelled) setSessions(next);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [workspaceId]);

  useEffect(() => {
    if (selectedSession === null) {
      setTranscript([]);
      return;
    }
    let cancelled = false;
    async function tick() {
      try {
        const next = await api.getTranscript(selectedSession!);
        if (!cancelled) setTranscript(next);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selectedSession]);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center gap-4">
        <h1 className="text-xl font-bold tracking-tight">clobber</h1>
        <WorkspaceSwitcher
          workspaces={workspaces}
          selectedId={workspaceId}
          onSelect={setWorkspaceId}
          onCreated={(ws) => {
            setWorkspaces((prev) => [ws, ...prev]);
            setWorkspaceId(ws.id);
          }}
        />
        <span className="text-zinc-500 text-sm">
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </span>
        {error !== null && (
          <span className="ml-auto text-red-400 text-xs font-mono">{error}</span>
        )}
      </header>

      <main className="flex-1 grid grid-cols-[18rem_minmax(0,1fr)_22rem] gap-0 overflow-hidden">
        <aside className="border-r border-zinc-800 overflow-y-auto">
          <SessionList
            sessions={sessions}
            selectedId={selectedSession}
            onSelect={setSelectedSession}
            onEnd={async (id) => {
              try {
                await api.endSession(id);
                if (workspaceId !== null) {
                  setSessions(await api.listSessions(workspaceId));
                }
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          />
        </aside>

        <section className="flex flex-col overflow-hidden">
          {(() => {
            const selected =
              selectedSession === null
                ? undefined
                : sessions.find((s) => s.session_id === selectedSession);
            if (selected === undefined) {
              return (
                <div className="flex items-center px-6 py-3 shrink-0">
                  <h2 className="text-sm uppercase tracking-wider text-zinc-500">
                    select a session
                  </h2>
                  <label className="ml-auto flex items-center gap-2 text-xs text-zinc-500 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={showSystem}
                      onChange={(e) => setShowSystem(e.target.checked)}
                      className="accent-emerald-600"
                    />
                    show details
                  </label>
                </div>
              );
            }
            return (
              <div className="flex items-stretch shrink-0">
                <div className="flex-1 min-w-0">
                  <SessionHeader session={selected} />
                </div>
                <label className="flex items-center gap-2 px-6 text-xs text-zinc-500 cursor-pointer select-none border-l border-zinc-800">
                  <input
                    type="checkbox"
                    checked={showSystem}
                    onChange={(e) => setShowSystem(e.target.checked)}
                    className="accent-emerald-600"
                  />
                  show details
                </label>
              </div>
            );
          })()}
          <TranscriptViewer
            key={selectedSession ?? "none"}
            lines={transcript}
            showSystem={showSystem}
          />
          {selectedSession !== null && (() => {
            const sel = sessions.find((s) => s.session_id === selectedSession);
            const open = sel?.open_question;
            return (
              <>
                {open !== undefined && (
                  <AskWidget
                    question={open}
                    onAnswer={async (answer) => {
                      await api.answerQuestion(selectedSession, open.id, answer);
                      if (workspaceId !== null) {
                        setSessions(await api.listSessions(workspaceId));
                      }
                    }}
                  />
                )}
                <PromptComposer
                  sessionId={selectedSession}
                  disabled={sel?.ended_at !== undefined}
                  busy={sel?.busy === true}
                  onSend={async (prompt) => {
                    await api.sendPrompt(selectedSession, prompt);
                    setTranscript(await api.getTranscript(selectedSession));
                  }}
                  onInterrupt={async () => {
                    await api.interruptSession(selectedSession);
                    setTranscript(await api.getTranscript(selectedSession));
                    if (workspaceId !== null) {
                      setSessions(await api.listSessions(workspaceId));
                    }
                  }}
                />
              </>
            );
          })()}
        </section>

        <aside className="border-l border-zinc-800 overflow-y-auto p-4 space-y-5">
          {workspaceId === null ? (
            <p className="text-sm text-zinc-500">
              Create or select a workspace to spawn agents.
            </p>
          ) : (
            <>
              <div className="space-y-2">
                <h2 className="text-sm uppercase tracking-wider text-zinc-500">role</h2>
                <RolePicker
                  assignments={assignments}
                  selectedRoleId={roleId}
                  onSelect={setRoleId}
                />
              </div>
              <SpawnPanel
                workspaceId={workspaceId}
                roleId={roleId}
                onSpawned={(s) => setSelectedSession(s.session_id)}
              />
            </>
          )}
        </aside>
      </main>
    </div>
  );
}
