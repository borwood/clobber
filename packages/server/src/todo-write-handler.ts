import { z } from "zod";
import type { PostToolUsePayload } from "@clobber/shared";
import type { SessionStore } from "./session-store.ts";
import type { AgentStatusLogStore } from "./agent-status-log-store.ts";

const TodoItemSchema = z.object({
  content: z.string(),
  activeForm: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed"]),
});

const TodoWriteInputSchema = z.object({
  todos: z.array(TodoItemSchema),
});

type TodoItem = z.infer<typeof TodoItemSchema>;

const ABSENT = "(absent)";
const REMOVED = "removed";

export interface TodoWriteHandlerDeps {
  readonly sessions: SessionStore;
  readonly agentStatusLog: AgentStatusLogStore;
}

export function applyTodoWrite(
  payload: PostToolUsePayload,
  deps: TodoWriteHandlerDeps,
): void {
  if (payload.tool_name !== "TodoWrite") return;

  const parsed = TodoWriteInputSchema.safeParse(payload.tool_input);
  if (!parsed.success) return;
  const todos = parsed.data.todos;

  const session = deps.sessions.get(payload.session_id);
  if (session === null) return;
  const agentId = session.agent_id;
  if (agentId === undefined) return;

  const previous = readPreviousSnapshot(deps.agentStatusLog, agentId);
  if (previous !== null && todoListsEqual(previous, todos)) return;

  deps.agentStatusLog.append({
    agent_id: agentId,
    session_id: payload.session_id,
    kind: "todo-snapshot",
    state: "snapshot",
    summary: snapshotSummary(todos),
    details: { todos },
  });

  for (const transition of diffTransitions(previous, todos)) {
    deps.agentStatusLog.append({
      agent_id: agentId,
      session_id: payload.session_id,
      kind: "phase-transition",
      state: transition.new_status,
      summary: `phase: ${transition.phase} — ${transition.prev_status} → ${transition.new_status}`,
      details: {
        phase: transition.phase,
        prev_status: transition.prev_status,
        new_status: transition.new_status,
      },
    });
  }
}

interface Transition {
  readonly phase: string;
  readonly prev_status: string;
  readonly new_status: string;
}

function diffTransitions(
  previous: readonly TodoItem[] | null,
  current: readonly TodoItem[],
): Transition[] {
  const out: Transition[] = [];
  const prevByContent = new Map<string, TodoItem>(
    (previous ?? []).map((t) => [t.content, t]),
  );
  const currentContents = new Set<string>();

  for (const item of current) {
    currentContents.add(item.content);
    const prev = prevByContent.get(item.content);
    const prevStatus = prev === undefined ? ABSENT : prev.status;
    if (prevStatus !== item.status) {
      out.push({
        phase: item.content,
        prev_status: prevStatus,
        new_status: item.status,
      });
    }
  }

  for (const prev of previous ?? []) {
    if (!currentContents.has(prev.content)) {
      out.push({
        phase: prev.content,
        prev_status: prev.status,
        new_status: REMOVED,
      });
    }
  }

  return out;
}

function readPreviousSnapshot(
  store: AgentStatusLogStore,
  agentId: string,
): TodoItem[] | null {
  const entries = store.listForAgent(agentId, { kind: "todo-snapshot", limit: 1 });
  if (entries.length === 0) return null;
  const details = entries[0]!.details;
  if (details === null) return null;
  const parsed = z.object({ todos: z.array(TodoItemSchema) }).safeParse(details);
  return parsed.success ? parsed.data.todos : null;
}

function todoListsEqual(a: readonly TodoItem[], b: readonly TodoItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.content !== y.content || x.status !== y.status || x.activeForm !== y.activeForm) {
      return false;
    }
  }
  return true;
}

function snapshotSummary(todos: readonly TodoItem[]): string {
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const t of todos) counts[t.status] += 1;
  const parts: string[] = [];
  if (counts.in_progress > 0) parts.push(`${counts.in_progress} in_progress`);
  if (counts.pending > 0) parts.push(`${counts.pending} pending`);
  if (counts.completed > 0) parts.push(`${counts.completed} completed`);
  return `${todos.length} todos${parts.length === 0 ? "" : `: ${parts.join(", ")}`}`;
}
