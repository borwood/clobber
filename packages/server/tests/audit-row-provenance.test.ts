import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createAgentStatusLogStore } from "../src/agent-status-log-store.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "clobber-audit-prov-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Initialize a git repo in dir, make an empty initial commit, return HEAD SHA.
function initGitRepo(dir: string): string {
  execSync("git init && git config user.email test@test.com && git config user.name Test", {
    cwd: dir,
    stdio: "pipe",
  });
  execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: "pipe" });
  return execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
}

// Make an empty commit and return the new HEAD SHA.
function addCommit(dir: string, msg: string): string {
  execSync(`git commit --allow-empty -m "${msg}"`, { cwd: dir, stdio: "pipe" });
  return execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
}


describe("audit-row provenance — sink-side stamping", () => {
  it("stamps commit, branch, and transcript_anchor on every row regardless of kind", () => {
    const repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir);
    initGitRepo(repoDir);

    const transcriptPath = join(tmpDir, "transcript.jsonl");
    const msgUuid = "aabbccdd-1111-2222-3333-444455556666";
    writeFileSync(transcriptPath, JSON.stringify({ type: "assistant", uuid: msgUuid }) + "\n");

    const db = createDatabase(":memory:");
    const workspaces = createWorkspaceStore(db);
    const roles = createRoleStore(db);
    const agents = createAgentStore(db);
    const sessions = createSessionStore(db);
    const statusLog = createAgentStatusLogStore(db);

    const ws = workspaces.create({ name: "ws", repo_path: repoDir });
    const role = roles.create({ name: "audit-test-role", persistent: false });
    const agent = agents.create({ workspace_id: ws.id, role_id: role.id, label: "tester" });
    const session = sessions.create({
      id: randomUUID(),
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 9999,
      transcript_path: transcriptPath,
    });

    // Append "status" kind — CLI-sourced; passes NO provenance fields.
    const statusRow = statusLog.append({
      agent_id: agent.id,
      session_id: session.id,
      kind: "status",
      state: "working",
      summary: "doing things",
    });

    expect(statusRow.commit).toBeString();
    expect(statusRow.commit!.length).toBe(40); // full SHA
    expect(statusRow.branch).toBeString();
    expect(statusRow.role_version_id).toBeNull();
    expect(statusRow.details?.transcript_anchor).toBe(msgUuid);

    // Append "final-report" kind — hook-sourced; also passes NO provenance fields.
    const reportRow = statusLog.append({
      agent_id: agent.id,
      session_id: session.id,
      kind: "final-report",
      state: "final",
      summary: "all done",
    });

    expect(reportRow.commit).toBe(statusRow.commit);
    expect(reportRow.branch).toBe(statusRow.branch);
    expect(reportRow.role_version_id).toBeNull();
    expect(reportRow.details?.transcript_anchor).toBe(msgUuid);
  });

  it("commit reflects the worktree HEAD at append time — a new commit changes the stamped SHA", () => {
    const repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir);
    initGitRepo(repoDir);

    const db = createDatabase(":memory:");
    const workspaces = createWorkspaceStore(db);
    const roles = createRoleStore(db);
    const agents = createAgentStore(db);
    const sessions = createSessionStore(db);
    const statusLog = createAgentStatusLogStore(db);

    const ws = workspaces.create({ name: "ws", repo_path: repoDir });
    const role = roles.create({ name: "audit-test-role", persistent: false });
    const agent = agents.create({ workspace_id: ws.id, role_id: role.id, label: "tester" });
    const session = sessions.create({
      id: randomUUID(),
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 9999,
    });

    const before = statusLog.append({
      agent_id: agent.id,
      session_id: session.id,
      kind: "status",
      state: "working",
      summary: "before commit",
    });

    const newSha = addCommit(repoDir, "second");

    const after = statusLog.append({
      agent_id: agent.id,
      session_id: session.id,
      kind: "status",
      state: "working",
      summary: "after commit",
    });

    expect(before.commit).not.toBe(newSha);
    expect(after.commit).toBe(newSha);
  });

  it("best-effort: non-git path yields null commit/branch, reason in details, row still persists", () => {
    const nonGitDir = join(tmpDir, "not-a-repo");
    mkdirSync(nonGitDir);

    const db = createDatabase(":memory:");
    const workspaces = createWorkspaceStore(db);
    const roles = createRoleStore(db);
    const agents = createAgentStore(db);
    const sessions = createSessionStore(db);
    const statusLog = createAgentStatusLogStore(db);

    const ws = workspaces.create({ name: "ws", repo_path: nonGitDir });
    const role = roles.create({ name: "audit-test-role", persistent: false });
    const agent = agents.create({ workspace_id: ws.id, role_id: role.id, label: "tester" });
    const session = sessions.create({
      id: randomUUID(),
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 9999,
    });

    // Must not throw — best-effort path.
    let row: ReturnType<typeof statusLog.append> | undefined;
    expect(() => {
      row = statusLog.append({
        agent_id: agent.id,
        session_id: session.id,
        kind: "status",
        state: "working",
        summary: "non-git path",
      });
    }).not.toThrow();

    expect(row).toBeDefined();
    expect(row!.commit).toBeNull();
    expect(row!.branch).toBeNull();
    // The reason for the failure is recorded in details.
    expect(row!.details?.provenance_error).toBeString();
    // role_version_id is null — sessions no longer carry a version pin (#491).
    expect(row!.role_version_id).toBeNull();
  });

  it("commit-pinned session stamps role_commit_sha + role_commit_branch; role_version_id is null (#486)", () => {
    const repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir);
    initGitRepo(repoDir);

    const db = createDatabase(":memory:");
    const workspaces = createWorkspaceStore(db);
    const roles = createRoleStore(db);
    const agents = createAgentStore(db);
    const sessions = createSessionStore(db);
    const statusLog = createAgentStatusLogStore(db);

    const ws = workspaces.create({ name: "ws", repo_path: repoDir });
    const role = roles.create({ name: "audit-commit-pin-role", persistent: true });
    const agent = agents.create({ workspace_id: ws.id, role_id: role.id, label: "manager" });
    const commitSha = "7b3f625900000000000000000000000000000000";
    const session = sessions.create({
      id: randomUUID(),
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      role_commit: { branch: "manager", sha: commitSha },
      pid: 9999,
    });

    const row = statusLog.append({
      agent_id: agent.id,
      session_id: session.id,
      kind: "status",
      state: "working",
      summary: "commit-pinned row",
    });

    expect(row.role_commit_sha).toBe(commitSha);
    expect(row.role_commit_branch).toBe("manager");
    expect(row.role_version_id).toBeNull();
  });

});
