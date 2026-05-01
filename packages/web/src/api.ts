import type { HookPayload, PermissionMode } from "@clobber/shared";

export interface StoredEvent {
  readonly id: number;
  readonly received_at: number;
  readonly payload: HookPayload;
}

export interface SessionSummary {
  readonly session_id: string;
  readonly first_seen_at: number;
  readonly last_seen_at: number;
  readonly event_count: number;
  readonly last_event_name: string;
}

export interface SpawnRequest {
  readonly prompt: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly permissionMode?: PermissionMode;
  readonly allowedTools?: readonly string[];
}

export interface SpawnResponse {
  readonly sessionId: string;
  readonly pid: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const api = {
  listSessions: () => getJson<SessionSummary[]>("/sessions"),
  listEvents: (sessionId?: string) =>
    getJson<StoredEvent[]>(sessionId ? `/events?session_id=${encodeURIComponent(sessionId)}` : "/events"),
  spawn: (req: SpawnRequest) => postJson<SpawnResponse>("/spawn", req),
};
