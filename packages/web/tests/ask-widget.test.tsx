import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { OpenQuestion } from "../src/api.ts";
import { AskWidget } from "../src/components/AskWidget.tsx";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button"));
}

function byText(text: string): HTMLButtonElement {
  const found = buttons().find((b) => (b.textContent ?? "").includes(text));
  if (found === undefined) throw new Error(`no button containing "${text}"`);
  return found;
}

function sendButton(): HTMLButtonElement {
  // The Send-all button is the only one whose label starts with "Send".
  const found = buttons().find((b) => (b.textContent ?? "").startsWith("Send"));
  if (found === undefined) throw new Error("no Send button");
  return found;
}

async function click(text: string): Promise<void> {
  await act(async () => {
    byText(text).click();
  });
}

async function render(question: OpenQuestion, onAnswer: (a: string) => Promise<void>) {
  await act(async () => {
    root.render(<AskWidget question={question} onAnswer={onAnswer} />);
  });
}

describe("AskWidget panel", () => {
  it("tabs each question, switches on tab click, and gates Send-all across tabs until all answered", async () => {
    const answers: string[] = [];
    const question: OpenQuestion = {
      id: "q-multi",
      asked_at: 1,
      status: "pending",
      questions: [
        {
          question: "Which datastore?",
          header: "Store",
          multi_select: false,
          options: [
            { label: "Sqlite", preview: "CREATE TABLE foo(...)" },
            { label: "Postgres" },
          ],
        },
        {
          question: "Which release strategy?",
          header: "Release",
          multi_select: false,
          options: [{ label: "RollForward" }, { label: "RollBack" }],
        },
      ],
    };
    await render(question, async (a) => {
      answers.push(a);
    });

    // Multi-question: both questions are tabs (headers present), but only the
    // active question's panel renders — Q1 + its rich preview show, Q2 is
    // behind its tab.
    expect(container.textContent).toContain("Store");
    expect(container.textContent).toContain("Release");
    expect(container.textContent).toContain("Which datastore?");
    expect(container.textContent).toContain("CREATE TABLE foo(...)");
    expect(container.textContent).not.toContain("Which release strategy?");

    // Nothing answered → Send disabled.
    expect(sendButton().disabled).toBe(true);

    // Answer only Q1 (active tab) → still gated on Q2.
    await click("Sqlite");
    expect(sendButton().disabled).toBe(true);

    // Switch to the Release tab → Q2's panel now renders; answer it.
    await click("Release");
    expect(container.textContent).toContain("Which release strategy?");
    await click("RollForward");
    expect(sendButton().disabled).toBe(false);
    await act(async () => {
      sendButton().click();
    });

    expect(answers).toHaveLength(1);
    expect(JSON.parse(answers[0]!)).toEqual({
      answers: [{ raw: "Sqlite" }, { raw: "RollForward" }],
    });
  });

  it("single question: submits the bare label (no envelope) — clobber-ask parity", async () => {
    const answers: string[] = [];
    const question: OpenQuestion = {
      id: "q-single",
      asked_at: 1,
      status: "pending",
      questions: [
        {
          question: "Ship it?",
          header: "Ship",
          multi_select: false,
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    };
    await render(question, async (a) => {
      answers.push(a);
    });

    expect(sendButton().disabled).toBe(true);
    await click("Yes");
    await act(async () => {
      sendButton().click();
    });

    expect(answers).toEqual(["Yes"]);
  });

  it("a timed-out ask stays actionable and annotates that the answer is sent as a new message (#183)", async () => {
    const answers: string[] = [];
    const question: OpenQuestion = {
      id: "q-timed-out",
      asked_at: 1,
      status: "timed_out",
      questions: [
        {
          question: "Ship it?",
          header: "Ship",
          multi_select: false,
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    };
    await render(question, async (a) => {
      answers.push(a);
    });

    // The widget tells the user a late answer routes as a new message, and the
    // control still submits (never silently inert).
    expect(container.textContent).toContain("timed out");
    await click("Yes");
    expect(sendButton().disabled).toBe(false);
    await act(async () => {
      sendButton().click();
    });

    expect(answers).toEqual(["Yes"]);
  });
});
