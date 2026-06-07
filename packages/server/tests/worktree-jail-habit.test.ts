// #540 — worktree-jail refuse-habit integration tests.
// Tests the SENTINEL EXPANSION path: the habit is stored with __REPO_PATH__ /
// __WORKTREE_ROOT__ / __DESK_DIR__ placeholders (as it lives in the role git
// tree). The server must expand them at evaluation time using workspace +
// session context.
//
// Before the expansion is implemented these DENY tests fail (the sentinels never
// match real absolute paths so isPathJailed always returns false).
import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { slugify } from "@clobber/shared";
import { buildHarness, teardown, habit, type RefuseHarness } from "./_habit-refuse-harness.ts";

const REPO = "/tmp/clobber-jail-test";
const LABEL = "test-worker";
const SLUG = slugify(LABEL);
const WORKTREE = join(dirname(REPO), `${basename(REPO)}-worktrees`, SLUG);

// The habit as stored in worktree-jail.json — sentinels not yet expanded.
const JAIL_HABIT = habit({
  path: "self.tool-use",
  phase: "pre",
  match: "Edit|Write|MultiEdit|Bash",
  name: "worktree-jail",
  action: {
    kind: "refuse",
    predicate: {
      outside: "__REPO_PATH__",
      under: "__WORKTREE_ROOT__",
      except: "__DESK_DIR__",
    },
    reason: "writes to main checkout are not permitted from a worktree session",
  },
});

function preToolUse(
  sessionId: string,
  cwd: string,
  toolName: string,
  toolInput: Record<string, unknown>,
) {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/t.jsonl",
    cwd,
    permission_mode: "bypassPermissions",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "toolu_test",
  } as const;
}

// Creates workspace + agent + session directly (no /spawn) to avoid git
// worktree add on a non-existent repo path.
function bootJailAgent(
  h: RefuseHarness,
  repoPath: string,
  label: string,
  worktreesOn: boolean,
): { sessionId: string; agentId: string } {
  const ws = h.workspaces.create({
    name: "ws",
    repo_path: repoPath,
    spawn_worktree: worktreesOn ? { kind: "on" } : { kind: "off" },
  });
  const role = h.roles.create({ name: "worker", persistent: false });
  h.workspaceRoles.setCeiling(ws.id, role.id, 5);
  const agent = h.agents.create({ workspace_id: ws.id, role_id: role.id, label });
  const sessionId = randomUUID();
  h.sessions.create({
    id: sessionId,
    agent_id: agent.id,
    workspace_id: ws.id,
    role_id: role.id,
    label,
    pid: 9999,
    runtime_provider: "claude",
  });
  return { sessionId, agentId: agent.id };
}

describe("worktree-jail habit — sentinel expansion", () => {
  it("out-of-worktree Edit is denied", async () => {
    const h = buildHarness(() => [JAIL_HABIT]);
    const { sessionId } = bootJailAgent(h, REPO, LABEL, true);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUse(sessionId, WORKTREE, "Edit", {
        file_path: join(REPO, "packages", "server", "src", "foo.ts"),
        old_string: "a",
        new_string: "b",
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const out = body.hookSpecificOutput as Record<string, unknown> | undefined;
    expect(out?.permissionDecision).toBe("deny");
    await teardown(h);
  });

  it("in-worktree Edit is allowed", async () => {
    const h = buildHarness(() => [JAIL_HABIT]);
    const { sessionId } = bootJailAgent(h, REPO, LABEL, true);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUse(sessionId, WORKTREE, "Edit", {
        file_path: join(WORKTREE, "packages", "server", "src", "foo.ts"),
        old_string: "a",
        new_string: "b",
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });

  it("desk Write is allowed", async () => {
    const h = buildHarness(() => [JAIL_HABIT]);
    const { sessionId, agentId } = bootJailAgent(h, REPO, LABEL, true);
    const deskFile = join(REPO, ".clobber", "agents", agentId, "desk", "notes.md");
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUse(sessionId, WORKTREE, "Write", {
        file_path: deskFile,
        content: "hello",
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });

  it("Bash redirect into main checkout is denied", async () => {
    const h = buildHarness(() => [JAIL_HABIT]);
    const { sessionId } = bootJailAgent(h, REPO, LABEL, true);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUse(sessionId, WORKTREE, "Bash", {
        command: `echo injected > ${join(REPO, "packages", "server", "src", "pwned.ts")}`,
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const out = body.hookSpecificOutput as Record<string, unknown> | undefined;
    expect(out?.permissionDecision).toBe("deny");
    await teardown(h);
  });

  it("worktrees-OFF: main-checkout Edit is allowed (short-circuit)", async () => {
    // When spawn_worktree is off, worktree_root === repo_path.
    // Expansion yields under: repo_path overriding outside: repo_path → allow everywhere.
    const h = buildHarness(() => [JAIL_HABIT]);
    const { sessionId } = bootJailAgent(h, REPO, LABEL, false);
    const res = await h.server.inject({
      method: "POST",
      url: "/hook",
      payload: preToolUse(sessionId, REPO, "Edit", {
        file_path: join(REPO, "packages", "server", "src", "foo.ts"),
        old_string: "a",
        new_string: "b",
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as unknown).toEqual({ continue: true });
    await teardown(h);
  });
});
