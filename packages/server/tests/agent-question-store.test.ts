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
});
