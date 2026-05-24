import { z } from "zod";
import type { PostToolUsePayload } from "@clobber/shared";
import type { SessionStore } from "./session-store.ts";
import type { AgentStatusLogStore } from "./agent-status-log-store.ts";

const TaskStatusSchema = z.enum(["pending", "in_progress", "completed"]);
type TaskStatus = z.infer<typeof TaskStatusSchema>;

const TaskSnapshotItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: TaskStatusSchema,
  activeForm: z.string().optional(),
});
type TaskSnapshotItem = z.infer<typeof TaskSnapshotItemSchema>;

const ABSENT = "(absent)";
const REMOVED = "removed";

// A normalized, tool-agnostic phase-plan mutation. The CLI's task surface
// (`TaskCreate`/`TaskUpdate`/…) is incremental — one task per call — so each
// hook is reduced into the reconstructed full task list before diffing, which
// lets the same snapshot+transition model that served the old full-list tool
// keep working over an incremental one.
type TaskMutation =
  | { readonly kind: "create"; readonly id: string; readonly content: string; readonly status: TaskStatus; readonly activeForm?: string }
  | { readonly kind: "update"; readonly id: string; readonly content?: string; readonly status?: TaskStatus; readonly activeForm?: string }
  | { readonly kind: "remove"; readonly id: string };

// Adapter registry keyed on tool name. Future CLI tool-surface drift stays
// additive: register a new tool's payload→mutation parser here, no core change.
type ToolAdapter = (payload: PostToolUsePayload) => TaskMutation | null;

const TaskCreateInputSchema = z.object({
  subject: z.string(),
  activeForm: z.string().optional(),
});
const TaskCreateResponseSchema = z.object({
  task: z.object({ id: z.string() }),
});

const TaskUpdateInputSchema = z.object({
  taskId: z.string(),
  subject: z.string().optional(),
  activeForm: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional(),
});

const TOOL_ADAPTERS: Record<string, ToolAdapter> = {
  TaskCreate(payload) {
    const input = TaskCreateInputSchema.safeParse(payload.tool_input);
    const response = TaskCreateResponseSchema.safeParse(payload.tool_response);
    if (!input.success || !response.success) return null;
    return {
      kind: "create",
      id: response.data.task.id,
      content: input.data.subject,
      status: "pending",
      ...activeFormFields(input.data.activeForm),
    };
  },
  TaskUpdate(payload) {
    const input = TaskUpdateInputSchema.safeParse(payload.tool_input);
    if (!input.success) return null;
    if (input.data.status === "deleted") {
      return { kind: "remove", id: input.data.taskId };
    }
    return {
      kind: "update",
      id: input.data.taskId,
      ...(input.data.subject === undefined ? {} : { content: input.data.subject }),
      ...(input.data.status === undefined ? {} : { status: input.data.status }),
      ...activeFormFields(input.data.activeForm),
    };
  },
};

export interface TaskEventHandlerDeps {
  readonly sessions: SessionStore;
  readonly agentStatusLog: AgentStatusLogStore;
}

export function applyTaskEvent(
  payload: PostToolUsePayload,
  deps: TaskEventHandlerDeps,
): void {
  const adapter = TOOL_ADAPTERS[payload.tool_name];
  if (adapter === undefined) return;

  const mutation = adapter(payload);
  if (mutation === null) return;

  const session = deps.sessions.get(payload.session_id);
  if (session === null) return;
  const agentId = session.agent_id;
  if (agentId === undefined) return;

  const previous = readPreviousSnapshot(deps.agentStatusLog, agentId);
  const current = reduce(previous, mutation);
  if (taskListsEqual(previous, current)) return;

  deps.agentStatusLog.append({
    agent_id: agentId,
    session_id: payload.session_id,
    kind: "task-snapshot",
    state: "snapshot",
    summary: snapshotSummary(current),
    details: { tasks: current },
  });

  for (const transition of diffTransitions(previous, current)) {
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

// Apply one incremental mutation onto the reconstructed task list, keyed by
// stable task id (so a subject rename keeps the phase's identity). create is
// idempotent against hook redelivery; update of an untracked id falls through
// to a no-op via the map.
function reduce(
  previous: readonly TaskSnapshotItem[],
  mutation: TaskMutation,
): TaskSnapshotItem[] {
  if (mutation.kind === "remove") {
    return previous.filter((t) => t.id !== mutation.id);
  }

  if (mutation.kind === "create") {
    const item: TaskSnapshotItem = {
      id: mutation.id,
      content: mutation.content,
      status: mutation.status,
      ...activeFormFields(mutation.activeForm),
    };
    if (previous.some((t) => t.id === mutation.id)) {
      return previous.map((t) => (t.id === mutation.id ? item : t));
    }
    return [...previous, item];
  }

  return previous.map((t) => (t.id === mutation.id ? applyUpdate(t, mutation) : t));
}

// A partial update omits the fields it does not touch; an omitted field keeps
// the task's prior value (this is the tool's documented contract, not a default
// masking missing data).
function applyUpdate(
  task: TaskSnapshotItem,
  mutation: { content?: string; status?: TaskStatus; activeForm?: string },
): TaskSnapshotItem {
  const content = mutation.content === undefined ? task.content : mutation.content;
  const status = mutation.status === undefined ? task.status : mutation.status;
  const activeForm = mutation.activeForm === undefined ? task.activeForm : mutation.activeForm;
  return { id: task.id, content, status, ...activeFormFields(activeForm) };
}

function activeFormFields(activeForm: string | undefined): { activeForm?: string } {
  return activeForm === undefined ? {} : { activeForm };
}

interface Transition {
  readonly phase: string;
  readonly prev_status: string;
  readonly new_status: string;
}

function diffTransitions(
  previous: readonly TaskSnapshotItem[],
  current: readonly TaskSnapshotItem[],
): Transition[] {
  const out: Transition[] = [];
  const prevById = new Map<string, TaskSnapshotItem>(previous.map((t) => [t.id, t]));
  const currentIds = new Set<string>();

  for (const item of current) {
    currentIds.add(item.id);
    const prev = prevById.get(item.id);
    const prevStatus = prev === undefined ? ABSENT : prev.status;
    if (prevStatus !== item.status) {
      out.push({ phase: item.content, prev_status: prevStatus, new_status: item.status });
    }
  }

  for (const prev of previous) {
    if (!currentIds.has(prev.id)) {
      out.push({ phase: prev.content, prev_status: prev.status, new_status: REMOVED });
    }
  }

  return out;
}

function readPreviousSnapshot(
  store: AgentStatusLogStore,
  agentId: string,
): TaskSnapshotItem[] {
  const entries = store.listForAgent(agentId, { kind: "task-snapshot", limit: 1 });
  if (entries.length === 0) return [];
  const details = entries[0]!.details;
  if (details === null) return [];
  const parsed = z.object({ tasks: z.array(TaskSnapshotItemSchema) }).safeParse(details);
  return parsed.success ? parsed.data.tasks : [];
}

function taskListsEqual(
  a: readonly TaskSnapshotItem[],
  b: readonly TaskSnapshotItem[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.content !== y.content || x.status !== y.status || x.activeForm !== y.activeForm) {
      return false;
    }
  }
  return true;
}

function snapshotSummary(tasks: readonly TaskSnapshotItem[]): string {
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const t of tasks) counts[t.status] += 1;
  const parts: string[] = [];
  if (counts.in_progress > 0) parts.push(`${counts.in_progress} in_progress`);
  if (counts.pending > 0) parts.push(`${counts.pending} pending`);
  if (counts.completed > 0) parts.push(`${counts.completed} completed`);
  return `${tasks.length} tasks${parts.length === 0 ? "" : `: ${parts.join(", ")}`}`;
}
