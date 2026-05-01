import { useEffect, useState } from "react";
import { api, type SessionSummary, type StoredEvent } from "./api.ts";
import { SpawnPanel } from "./components/SpawnPanel.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { EventLog } from "./components/EventLog.tsx";

const POLL_MS = 1000;

export function App() {
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<readonly StoredEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const next = await api.listSessions();
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
  }, []);

  useEffect(() => {
    if (selected === null) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    async function tick() {
      try {
        const next = await api.listEvents(selected!);
        if (!cancelled) setEvents(next);
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
  }, [selected]);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center gap-4">
        <h1 className="text-xl font-bold tracking-tight">clobber</h1>
        <span className="text-zinc-500 text-sm">{sessions.length} session{sessions.length === 1 ? "" : "s"}</span>
        {error !== null && (
          <span className="ml-auto text-red-400 text-xs font-mono">{error}</span>
        )}
      </header>

      <main className="flex-1 grid grid-cols-[18rem_minmax(0,1fr)_22rem] gap-0 overflow-hidden">
        <aside className="border-r border-zinc-800 overflow-y-auto">
          <SessionList
            sessions={sessions}
            selectedId={selected}
            onSelect={setSelected}
          />
        </aside>

        <section className="overflow-y-auto p-6">
          <h2 className="text-sm uppercase tracking-wider text-zinc-500 mb-3">
            {selected === null ? "select a session" : `events · ${selected.slice(0, 8)}`}
          </h2>
          <EventLog events={events} />
        </section>

        <aside className="border-l border-zinc-800 overflow-y-auto p-4">
          <SpawnPanel onSpawned={(s) => setSelected(s.sessionId)} />
        </aside>
      </main>
    </div>
  );
}
