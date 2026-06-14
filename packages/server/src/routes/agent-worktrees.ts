import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withAgentAuth } from "./_with-agent-auth.ts";
import type { WithAgentAuthDeps } from "./_with-agent-auth.ts";
import type { AgentStore } from "../agent-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { WorkspaceStore } from "../workspace-store.ts";

export interface AgentWorktreesDeps extends WithAgentAuthDeps {
  readonly agents: AgentStore;
  readonly sessions: SessionStore;
  readonly workspaces: Pick<WorkspaceStore, "get" | "updateConfig">;
}

const SetPathBody = z.object({
  path: z.string().min(1),
});

const SetAgentBody = z.object({
  agent_id: z.string().uuid(),
  path: z.string().min(1),
});

const SetDefaultBody = z.object({
  branch_prefix: z.string(),
  worktree_root: z.string().optional(),
});

function moveWorktree(repoPath: string, from: string, to: string): void {
  const res = Bun.spawnSync(
    ["git", "-C", repoPath, "worktree", "move", from, to],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (res.exitCode !== 0) {
    throw new Error(
      `git worktree move failed (exit ${res.exitCode}): ${res.stderr.toString().trim()}`,
    );
  }
}

export function registerAgentWorktreesRoutes(
  app: FastifyInstance,
  deps: AgentWorktreesDeps,
): void {
  // worktrees.set — move the caller's own agent worktree to a new path.
  app.post(
    "/agent/worktrees/set",
    withAgentAuth("worktrees.set", deps, async (request, reply, { session }) => {
      const parsed = SetPathBody.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid request", issues: parsed.error.issues };
      }
      if (session.agent_id === undefined) {
        reply.code(400);
        return { error: "session has no agent" };
      }
      const agent = deps.agents.get(session.agent_id);
      if (agent === null || agent.workspace_id !== session.workspace_id) {
        reply.code(404);
        return { error: "agent not found" };
      }
      if (agent.worktree_path === undefined || agent.worktree_branch === undefined) {
        reply.code(400);
        return { error: "agent has no worktree to move" };
      }
      const workspace = deps.workspaces.get(session.workspace_id);
      if (workspace === null) {
        reply.code(500);
        return { error: "workspace missing for session" };
      }
      moveWorktree(workspace.repo_path, agent.worktree_path, parsed.data.path);
      deps.agents.setWorktreeIdentity(agent.id, agent.worktree_branch, parsed.data.path);
      return { ok: true, path: parsed.data.path };
    }),
  );

  // worktrees.set-agent — move a named agent's worktree (T3: idle-only guard).
  app.post(
    "/agent/worktrees/set-agent",
    withAgentAuth("worktrees.set-agent", deps, async (request, reply, { session }) => {
      const parsed = SetAgentBody.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid request", issues: parsed.error.issues };
      }
      const agent = deps.agents.get(parsed.data.agent_id);
      if (agent === null || agent.workspace_id !== session.workspace_id) {
        reply.code(404);
        return { error: "agent not found" };
      }
      if (agent.worktree_path === undefined || agent.worktree_branch === undefined) {
        reply.code(400);
        return { error: "agent has no worktree to move" };
      }
      // T3: refuse if the agent has an active (non-ended) session.
      const latest = deps.sessions.latestForAgent(agent.id);
      if (latest !== null && latest.ended_at === undefined) {
        reply.code(409);
        return { error: "cannot move worktree: agent has an active session" };
      }
      const workspace = deps.workspaces.get(session.workspace_id);
      if (workspace === null) {
        reply.code(500);
        return { error: "workspace missing for session" };
      }
      moveWorktree(workspace.repo_path, agent.worktree_path, parsed.data.path);
      deps.agents.setWorktreeIdentity(agent.id, agent.worktree_branch, parsed.data.path);
      return { ok: true, path: parsed.data.path };
    }),
  );

  // worktrees.set-default — set the workspace branch-prefix/worktree-root
  // convention for new agent worktrees. Read-merge-write: only the fields
  // present in the request body are updated; absent fields keep their current
  // values. Empty branch_prefix reverts to bare slug (clears any prefix).
  app.put(
    "/agent/worktrees/default",
    withAgentAuth("worktrees.set-default", deps, async (request, reply, { session }) => {
      const parsed = SetDefaultBody.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid request", issues: parsed.error.issues };
      }
      const { branch_prefix: prefix, worktree_root: root } = parsed.data;
      const workspace = deps.workspaces.get(session.workspace_id);
      if (workspace === null) {
        reply.code(404);
        return { error: "workspace not found" };
      }
      // Preserve sibling fields not present in this request
      const existingRoot =
        workspace.spawn_worktree.kind === "on"
          ? workspace.spawn_worktree.worktree_root
          : undefined;
      const resolvedRoot = root !== undefined && root !== "" ? root : existingRoot;
      const updated = deps.workspaces.updateConfig(session.workspace_id, {
        spawn_worktree: {
          kind: "on",
          ...(prefix !== "" ? { branch_prefix: prefix } : {}),
          ...(resolvedRoot !== undefined ? { worktree_root: resolvedRoot } : {}),
        },
      });
      if (updated === null) {
        reply.code(404);
        return { error: "workspace not found" };
      }
      return {
        ok: true,
        branch_prefix: prefix !== "" ? prefix : null,
        worktree_root: resolvedRoot !== undefined ? resolvedRoot : null,
      };
    }),
  );
}
