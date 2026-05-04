import type {
  Workspace,
  CreateWorkspaceRequest,
  Role,
  WorkspaceRoleAssignment,
  LatestAgentStatus,
} from "@clobber/shared";

export type {
  Workspace,
  Role,
  WorkspaceRoleAssignment,
  LatestAgentStatus,
  AgentState,
} from "@clobber/shared";

export interface OpenQuestion {
  readonly id: string;
  readonly question: string;
  readonly options?: readonly string[];
  readonly asked_at: number;
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
  readonly latest_status?: LatestAgentStatus;
  readonly open_question?: OpenQuestion;
}

export interface SpawnRequest {
  readonly workspace_id: string;
  readonly role_id: string;
  readonly prompt: string;
  readonly label?: string;
}

export interface SpawnResponse {
  readonly agent_id: string;
  readonly session_id: string;
  readonly pid: number;
}

export type TranscriptLine = Record<string, unknown>;

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

export const api = {
  listSessions: (workspaceId: string) =>
    getJson<SessionSummary[]>(
      `/sessions?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),
  listWorkspaces: () => getJson<Workspace[]>("/workspaces"),
  createWorkspace: (req: CreateWorkspaceRequest) => postJson<Workspace>("/workspaces", req),
  listWorkspaceRoles: (workspaceId: string) =>
    getJson<WorkspaceRoleAssignment[]>(
      `/workspaces/${encodeURIComponent(workspaceId)}/roles`,
    ),
  spawn: (req: SpawnRequest) => postJson<SpawnResponse>("/spawn", req),
  getTranscript: (sessionId: string) =>
    getJson<TranscriptLine[]>(`/sessions/${encodeURIComponent(sessionId)}/transcript`),
  endSession: (sessionId: string) =>
    postJson<{ ok: true }>(
      `/sessions/${encodeURIComponent(sessionId)}/end`,
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
};
