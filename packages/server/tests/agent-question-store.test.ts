import { describe, it, expect } from "bun:test";
import type { AskQuestion } from "@clobber/shared";
import { createDatabase } from "../src/db.ts";
import { createWorkspaceStore } from "../src/workspace-store.ts";
import { createRoleStore } from "../src/role-store.ts";
import { createAgentStore } from "../src/agent-store.ts";
import { createSessionStore } from "../src/session-store.ts";
import { createAgentQuestionStore } from "../src/agent-question-store.ts";

function open() {
  const db = createDatabase(":memory:");
  const workspaces = createWorkspaceStore(db);
  const roles = createRoleStore(db);
  const agents = createAgentStore(db);
  const sessions = createSessionStore(db);
  const questions = createAgentQuestionStore(db);
  return { db, workspaces, roles, agents, sessions, questions };
}

function seedSession(deps: ReturnType<typeof open>, id = "s1") {
  const ws = deps.workspaces.create({ name: `ws-${id}`, repo_path: "/r" });
  const role = deps.roles.create({ name: `r-${id}`, persistent: false });
  const agent = deps.agents.create({ workspace_id: ws.id, role_id: role.id });
  deps.sessions.create({
    id,
    agent_id: agent.id,
    workspace_id: ws.id,
    role_id: role.id,
    pid: 1,
  });
  return { ws, role, agent, sessionId: id };
}

function q(question: string): AskQuestion {
  return { question, multi_select: false };
}

describe("agent question store", () => {
  it("create persists a pending question and get reads it back", () => {
    const deps = open();
    const { sessionId } = seedSession(deps);

    const created = deps.questions.create({
      session_id: sessionId,
      questions: [q("ship it?")],
    });

    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(created.session_id).toBe(sessionId);
    expect(created.questions).toEqual([{ question: "ship it?", multi_select: false }]);
    expect(created.status).toBe("pending");
    expect(created.answer).toBeUndefined();
    expect(created.answered_at).toBeUndefined();
    expect(created.asked_at).toBeGreaterThan(0);

    expect(deps.questions.get(created.id)).toEqual(created);
    deps.db.close();
  });

  it("round-trips a multi-question panel with per-option preview + per-question multi_select", () => {
    const deps = open();
    const { sessionId } = seedSession(deps);

    const questions: AskQuestion[] = [
      {
        question: "merge?",
        header: "Merge",
        multi_select: true,
        options: [
          { label: "yes" },
          { label: "no", description: "leave the branch open" },
          { label: "later", preview: "remind me at v2 cut" },
        ],
      },
      {
        question: "which db?",
        header: "Store",
        multi_select: false,
        options: [
          { label: "sqlite", preview: "CREATE TABLE …" },
          { label: "postgres" },
        ],
      },
    ];

    const created = deps.questions.create({ session_id: sessionId, questions });

    expect(created.questions).toEqual(questions);
    expect(created.questions[0]!.options![2]!.preview).toBe("remind me at v2 cut");
    expect(created.questions[1]!.multi_select).toBe(false);
    expect(deps.questions.get(created.id)).toEqual(created);
    deps.db.close();
  });

  it("answer marks pending → answered with the answer text and timestamp", () => {
    const deps = open();
    const { sessionId } = seedSession(deps);
    const created = deps.questions.create({ session_id: sessionId, questions: [q("go?")] });

    expect(deps.questions.answer(created.id, "yes")).toBe(true);

    const after = deps.questions.get(created.id)!;
    expect(after.status).toBe("answered");
    expect(after.answer).toBe("yes");
    expect(after.answered_at).toBeGreaterThanOrEqual(after.asked_at);
    deps.db.close();
  });

  it("answer is no-op (returns false) when the question is already resolved", () => {
    const deps = open();
    const { sessionId } = seedSession(deps);
    const created = deps.questions.create({ session_id: sessionId, questions: [q("go?")] });
    deps.questions.answer(created.id, "yes");

    expect(deps.questions.answer(created.id, "no")).toBe(false);
    expect(deps.questions.get(created.id)!.answer).toBe("yes");
    deps.db.close();
  });

  it("cancelAllForSession transitions every pending question to cancelled, leaves resolved alone", () => {
    const deps = open();
    const { sessionId } = seedSession(deps);
    const a = deps.questions.create({ session_id: sessionId, questions: [q("a?")] });
    const b = deps.questions.create({ session_id: sessionId, questions: [q("b?")] });
    const c = deps.questions.create({ session_id: sessionId, questions: [q("c?")] });
    deps.questions.answer(b.id, "yes");

    const cancelledIds = deps.questions.cancelAllForSession(sessionId);

    expect(cancelledIds.sort()).toEqual([a.id, c.id].sort());
    expect(deps.questions.get(a.id)!.status).toBe("cancelled");
    expect(deps.questions.get(b.id)!.status).toBe("answered");
    expect(deps.questions.get(c.id)!.status).toBe("cancelled");
    deps.db.close();
  });

  it("getOpenForSession returns only the latest pending question (or null)", () => {
    const deps = open();
    const { sessionId } = seedSession(deps);

    expect(deps.questions.getOpenForSession(sessionId)).toBeNull();

    const a = deps.questions.create({ session_id: sessionId, questions: [q("first?")] });
    expect(deps.questions.getOpenForSession(sessionId)!.id).toBe(a.id);

    deps.questions.answer(a.id, "ok");
    expect(deps.questions.getOpenForSession(sessionId)).toBeNull();

    const b = deps.questions.create({ session_id: sessionId, questions: [q("second?")] });
    expect(deps.questions.getOpenForSession(sessionId)!.id).toBe(b.id);
    deps.db.close();
  });

  it("session deletion cascades to questions", () => {
    const deps = open();
    const { sessionId, ws } = seedSession(deps);
    const created = deps.questions.create({ session_id: sessionId, questions: [q("x?")] });

    deps.workspaces.delete(ws.id);

    expect(deps.questions.get(created.id)).toBeNull();
    deps.db.close();
  });

  it("listForAgent returns answered questions across sessions for one agent, newest first", () => {
    const deps = open();
    const ws = deps.workspaces.create({ name: "ws-list", repo_path: "/r" });
    const role = deps.roles.create({ name: "r-list", persistent: false });
    const agent = deps.agents.create({ workspace_id: ws.id, role_id: role.id });
    deps.sessions.create({
      id: "sA",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1,
    });
    deps.sessions.create({
      id: "sB",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 2,
    });

    const qa = deps.questions.create({ session_id: "sA", questions: [q("a?")] });
    const qb = deps.questions.create({ session_id: "sB", questions: [q("b?")] });
    deps.questions.answer(qa.id, "answer-a");
    deps.questions.answer(qb.id, "answer-b");

    const answered = deps.questions.listForAgent(agent.id, { status: "answered" });

    expect(answered).toHaveLength(2);
    expect(answered[0]!.asked_at).toBeGreaterThanOrEqual(answered[1]!.asked_at);
    expect(answered.map((q) => q.id).sort()).toEqual([qa.id, qb.id].sort());
    expect(answered.find((q) => q.id === qa.id)!.answer).toBe("answer-a");
    expect(answered.find((q) => q.id === qb.id)!.answer).toBe("answer-b");

    // no regression
    expect(deps.questions.get(qa.id)!.status).toBe("answered");
    expect(deps.questions.getOpenForSession("sA")).toBeNull();
    deps.db.close();
  });

  it("listForAgent with no status filter returns all statuses for agent", () => {
    const deps = open();
    const ws = deps.workspaces.create({ name: "ws-list2", repo_path: "/r" });
    const role = deps.roles.create({ name: "r-list2", persistent: false });
    const agent = deps.agents.create({ workspace_id: ws.id, role_id: role.id });
    deps.sessions.create({
      id: "sC",
      agent_id: agent.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1,
    });

    const q1 = deps.questions.create({ session_id: "sC", questions: [q("pending?")] });
    const q2 = deps.questions.create({ session_id: "sC", questions: [q("answered?")] });
    deps.questions.answer(q2.id, "yes");

    const all = deps.questions.listForAgent(agent.id);

    expect(all).toHaveLength(2);
    expect(all.map((q) => q.id).sort()).toEqual([q1.id, q2.id].sort());
    deps.db.close();
  });

  it("listForAgent does not return another agent's questions", () => {
    const deps = open();
    const ws = deps.workspaces.create({ name: "ws-list3", repo_path: "/r" });
    const role = deps.roles.create({ name: "r-list3", persistent: false });
    const agent1 = deps.agents.create({ workspace_id: ws.id, role_id: role.id });
    const agent2 = deps.agents.create({ workspace_id: ws.id, role_id: role.id });
    deps.sessions.create({
      id: "sD",
      agent_id: agent1.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 1,
    });
    deps.sessions.create({
      id: "sE",
      agent_id: agent2.id,
      workspace_id: ws.id,
      role_id: role.id,
      pid: 2,
    });

    deps.questions.create({ session_id: "sD", questions: [q("agent1?")] });
    const qe = deps.questions.create({ session_id: "sE", questions: [q("agent2?")] });
    deps.questions.answer(qe.id, "ok");

    const agent1Answered = deps.questions.listForAgent(agent1.id, { status: "answered" });
    expect(agent1Answered).toHaveLength(0);
    deps.db.close();
  });
});
