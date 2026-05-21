import type { Database } from "bun:sqlite";
import type {
  FinalReportCallback,
  FinalReportPayload,
} from "@clobber/shared";
import type { Clock, TimeoutHandle } from "./clock.ts";
import { createSystemClock } from "./clock.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import type { AgentStatusLogStore } from "./agent-status-log-store.ts";

export interface FinalReportConsumerStateStore {
  getLastConsumedId(workspaceId: string): number;
  setLastConsumedId(workspaceId: string, lastId: number): void;
}

export function createFinalReportConsumerStateStore(
  db: Database,
): FinalReportConsumerStateStore {
  const getStmt = db.prepare(
    "SELECT last_consumed_id FROM final_report_consumer_state WHERE workspace_id = ?",
  );
  const upsertStmt = db.prepare(
    `INSERT INTO final_report_consumer_state (workspace_id, last_consumed_id)
     VALUES (?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET last_consumed_id = excluded.last_consumed_id`,
  );
  return {
    getLastConsumedId(workspaceId) {
      const row = getStmt.get(workspaceId) as { last_consumed_id: number } | null;
      return row === null ? 0 : row.last_consumed_id;
    },
    setLastConsumedId(workspaceId, lastId) {
      upsertStmt.run(workspaceId, lastId);
    },
  };
}

export interface CallbackRunner {
  run(callback: FinalReportCallback, payload: FinalReportPayload): Promise<void>;
}

export interface FinalReportConsumerDeps {
  readonly db: Database;
  readonly workspaces: WorkspaceStore;
  readonly agentStatusLog: AgentStatusLogStore;
  readonly stateStore: FinalReportConsumerStateStore;
  readonly clock?: Clock;
  readonly pollIntervalMs?: number;
  readonly runner?: CallbackRunner;
}

export interface DrainResult {
  readonly processed: number;
  readonly errors: number;
}

export interface FinalReportConsumer {
  start(): void;
  stop(): void;
  drainOnce(): Promise<DrainResult>;
}

interface UnconsumedRow {
  readonly log_id: number;
  readonly workspace_id: string;
  readonly agent_id: string;
  readonly session_id: string;
  readonly state: string;
  readonly summary: string;
  readonly details_json: string | null;
  readonly created_at: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;

export function createFinalReportConsumer(
  deps: FinalReportConsumerDeps,
): FinalReportConsumer {
  const clock = deps.clock ?? createSystemClock();
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const runner = deps.runner ?? defaultCallbackRunner;

  const selectStmt = deps.db.prepare<
    UnconsumedRow,
    [string, number]
  >(`
    SELECT
      log.id          AS log_id,
      s.workspace_id  AS workspace_id,
      log.agent_id    AS agent_id,
      log.session_id  AS session_id,
      log.state       AS state,
      log.summary     AS summary,
      log.details_json AS details_json,
      log.created_at  AS created_at
    FROM agent_status_log log
    JOIN sessions s ON s.id = log.session_id
    WHERE log.kind = 'final-report'
      AND s.workspace_id = ?
      AND log.id > ?
    ORDER BY log.id ASC
  `);

  let started = false;
  let pollHandle: TimeoutHandle | null = null;
  let pendingTick: Promise<void> | null = null;

  async function drainOnce(): Promise<DrainResult> {
    const workspaces = deps.workspaces.list();
    let processed = 0;
    let errors = 0;
    for (const workspace of workspaces) {
      const cursor = deps.stateStore.getLastConsumedId(workspace.id);
      const rows = selectStmt.all(workspace.id, cursor);
      for (const row of rows) {
        const report = row.details_json === null
          ? {}
          : (JSON.parse(row.details_json) as Record<string, unknown>);
        const payload: FinalReportPayload = {
          workspace_id: row.workspace_id,
          agent_id: row.agent_id,
          session_id: row.session_id,
          kind: "final-report",
          state: row.state,
          summary: row.summary,
          report,
          created_at: row.created_at,
          log_id: row.log_id,
        };
        try {
          await runner.run(workspace.final_report_callback, payload);
        } catch (err) {
          errors += 1;
          deps.agentStatusLog.append({
            agent_id: row.agent_id,
            session_id: row.session_id,
            kind: "callback-error",
            state: "error",
            summary: `final-report callback failed: ${workspace.final_report_callback.kind}`,
            details: {
              callback_kind: workspace.final_report_callback.kind,
              source_log_id: row.log_id,
              error: errorMessage(err),
            },
          });
        }
        deps.stateStore.setLastConsumedId(workspace.id, row.log_id);
        processed += 1;
      }
    }
    return { processed, errors };
  }

  function schedule(): void {
    pollHandle = clock.setTimeout(() => {
      pollHandle = null;
      pendingTick = drainOnce()
        .catch(() => undefined)
        .then(() => {
          pendingTick = null;
          if (started) schedule();
        });
    }, pollIntervalMs);
  }

  return {
    start() {
      if (started) return;
      started = true;
      schedule();
    },
    stop() {
      started = false;
      if (pollHandle !== null) {
        clock.clearTimeout(pollHandle);
        pollHandle = null;
      }
    },
    drainOnce,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const defaultCallbackRunner: CallbackRunner = {
  async run(callback, payload) {
    if (callback.kind === "noop") return;
    if (callback.kind === "exec") {
      await runExec(callback.command, callback.args ?? [], payload);
      return;
    }
    await runHttp(callback.url, callback.headers ?? {}, payload);
  },
};

async function runExec(
  command: string,
  args: readonly string[],
  payload: FinalReportPayload,
): Promise<void> {
  const proc = Bun.spawn([command, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `exec callback exited ${code}: ${stderr.trim().slice(0, 500)}`,
    );
  }
}

async function runHttp(
  url: string,
  headers: Record<string, string>,
  payload: FinalReportPayload,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `http callback responded ${res.status}: ${body.trim().slice(0, 500)}`,
    );
  }
}
