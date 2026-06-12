import type {
  Workspace,
  CreateWorkspaceRequest,
  Role,
  WorkspaceRoleAssignment,
  LatestAgentStatus,
  RoleVersionRef,
  BrowseDirResponse,
  FileReadResponse,
  SessionLocationsResponse,
  UpdateWorkspaceConfigRequest,
  AskQuestion,
  SequencedLayoutEvent,
  TranscriptLine,
  Notification,
} from "@clobber/shared";

export type {
  Workspace,
  Role,
  WorkspaceRoleAssignment,
  LatestAgentStatus,
  AgentState,
  RoleVersionRef,
  SettingSource,
  AskOption,
  AskQuestion,
  TranscriptLine,
  Notification,
} from "@clobber/shared";

export interface OpenQuestion {
  readonly id: string;
  readonly questions: readonly AskQuestion[];
  readonly asked_at: number;
  // `timed_out` keeps the widget actionable but flags that a selection arrives
  // as a fresh injected message rather than the agent's parked wait (#183).
  readonly status: "pending" | "timed_out";
}

export interface SessionSummary {
  readonly session_id: string;
  readonly role_name: string;
  readonly label?: string;
  readonly first_seen_at: number;
  readonly last_seen_at: number;
  readonly event_count: number;
  readonly last_event_name?: string;
  readonly ended_at?: number;
  readonly was_live_at_shutdown?: boolean;
  readonly latest_status?: LatestAgentStatus;
  readonly open_question?: OpenQuestion;
  readonly role_version?: RoleVersionRef;
  readonly role_current_version?: RoleVersionRef;
  readonly busy?: boolean;
  readonly model?: string;
  readonly effort?: string;
  readonly context_tokens?: number;
}

export interface OfficePeek {
  readonly file_count: number;
  readonly latest: {
    readonly name: string;
    readonly mtime_ms: number;
    readonly preview: string;
  } | null;
}

export interface SessionView {
  readonly id: string;
  readonly started_at: number;
  readonly busy: boolean;
  readonly latest_status: LatestAgentStatus | null;
}

export interface OfficeCard {
  readonly agent_id: string;
  readonly label: string | null;
  readonly role: { readonly id: string; readonly name: string };
  readonly active_session: SessionView | null;
  readonly last_started_at: number | null;
  readonly office: OfficePeek;
  // Wake-programs the office affordance can offer — `idle` first, then the
  // role's declared programs (#213).
  readonly wake_programs: readonly string[];
}

export interface DeskCard {
  readonly agent_id: string;
  readonly label: string | null;
  readonly role: { readonly id: string; readonly name: string };
  readonly session: SessionView;
}

export interface Whiteboard {
  readonly offices: readonly OfficeCard[];
  readonly desks: readonly DeskCard[];
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type Model = "opus" | "sonnet" | "haiku" | "fable";

export interface SpawnRequest {
  readonly workspace_id: string;
  readonly role_id: string;
  // Optional — only meaningful for `custom` wake-program. Absent = no kick.
  readonly prompt?: string;
  readonly label?: string;
  readonly effort?: EffortLevel;
  readonly model?: Model;
  readonly wake_program?: string;
  // Caller-supplied layer-C addon for the `custom` built-in (#501).
  readonly system_addon?: string;
}

export interface SpawnResponse {
  readonly agent_id: string;
  readonly session_id: string;
  readonly pid: number;
}

async function failureMessage(res: Response): Promise<string> {
  const text = await res.text();
  const isJson = res.headers.get("content-type")?.includes("application/json") === true;
  if (isJson) {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  }
  return `${res.status} ${text}`;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`GET ${path} failed: ${await failureMessage(res)}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await failureMessage(res));
  return (await res.json()) as T;
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} failed: ${await failureMessage(res)}`);
  return (await res.json()) as T;
}

export const api = {
  listSessions: (workspaceId: string) =>
    getJson<SessionSummary[]>(
      `/sessions?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),
  listWorkspaces: () => getJson<Workspace[]>("/workspaces"),
  liveWorkspaceIds: () => getJson<string[]>("/sessions/live-workspaces"),
  createWorkspace: (req: CreateWorkspaceRequest) => postJson<Workspace>("/workspaces", req),
  listWorkspaceRoles: (workspaceId: string) =>
    getJson<WorkspaceRoleAssignment[]>(
      `/workspaces/${encodeURIComponent(workspaceId)}/roles`,
    ),
  spawn: (req: SpawnRequest) => postJson<SpawnResponse>("/spawn", req),
  getWhiteboard: (workspaceId: string) =>
    getJson<Whiteboard>(`/workspaces/${encodeURIComponent(workspaceId)}/whiteboard`),
  wakePersistentAgent: (agentId: string, wakeProgram?: string) =>
    postJson<SpawnResponse>(
      `/persistent-agents/${encodeURIComponent(agentId)}/wake`,
      wakeProgram === undefined ? {} : { wake_program: wakeProgram },
    ),
  getTranscript: (sessionId: string) =>
    getJson<TranscriptLine[]>(`/sessions/${encodeURIComponent(sessionId)}/transcript`),
  endSession: (sessionId: string) =>
    postJson<{ ok: true }>(
      `/sessions/${encodeURIComponent(sessionId)}/end`,
      {},
    ),
  resumeSession: (sessionId: string, prompt?: string) =>
    postJson<{ ok: true; session_id: string; pid: number }>(
      `/sessions/${encodeURIComponent(sessionId)}/resume`,
      prompt !== undefined ? { prompt } : {},
    ),
  interruptSession: (sessionId: string) =>
    postJson<{ ok: true }>(
      `/sessions/${encodeURIComponent(sessionId)}/interrupt`,
      {},
    ),
  sendPrompt: (sessionId: string, prompt: string) =>
    postJson<{ ok: true }>(
      `/sessions/${encodeURIComponent(sessionId)}/prompt`,
      { prompt },
    ),
  answerQuestion: (sessionId: string, questionId: string, answer: string) =>
    postJson<{ ok: true }>(
      `/sessions/${encodeURIComponent(sessionId)}/answer`,
      { question_id: questionId, answer },
    ),
  browseFs: (path?: string, includeFiles?: boolean) => {
    const params = new URLSearchParams();
    if (path !== undefined) params.set("path", path);
    if (includeFiles === true) params.set("includeFiles", "true");
    const qs = params.toString();
    return getJson<BrowseDirResponse>(qs.length > 0 ? `/fs/browse?${qs}` : "/fs/browse");
  },
  readFile: (path: string) =>
    getJson<FileReadResponse>(`/fs/read?path=${encodeURIComponent(path)}`),
  getSessionLocations: (sessionId: string) =>
    getJson<SessionLocationsResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/locations`,
    ),
  updateWorkspaceConfig: (id: string, body: UpdateWorkspaceConfigRequest) =>
    patchJson<Workspace>(`/workspaces/${encodeURIComponent(id)}`, body),
  notifyWorkspaceOpen: (id: string) =>
    postJson<{ dispatched: number }>(
      `/workspaces/${encodeURIComponent(id)}/open`,
      {},
    ),
  getLayoutEvents: (workspaceId: string, since: number) =>
    getJson<SequencedLayoutEvent[]>(
      `/workspaces/${encodeURIComponent(workspaceId)}/layout-events?since=${since}`,
    ),
  listUserNotifications: () =>
    getJson<{ notifications: readonly Notification[] }>("/notifications?recipient=user"),
  ackNotification: (id: string) =>
    postJson<{ ok: true }>(`/notifications/${encodeURIComponent(id)}/ack`, {}),
};
