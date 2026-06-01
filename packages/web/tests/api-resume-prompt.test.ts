import { describe, expect, it, spyOn, mock } from "bun:test";

// Mock fetch before importing api so postJson uses our spy
const requests: Array<{ url: string; body: unknown }> = [];

(global as { fetch: unknown }).fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const body = init?.body !== undefined ? JSON.parse(init.body as string) : undefined;
  requests.push({ url, body });
  return new Response(JSON.stringify({ ok: true, session_id: "s1", pid: 1 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

import { api } from "../src/api.ts";

describe("api.resumeSession", () => {
  it("sends empty body when no prompt provided", async () => {
    requests.length = 0;
    await api.resumeSession("session-abc");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain("session-abc");
    expect(requests[0]!.body).toEqual({});
  });

  it("sends prompt in body when provided", async () => {
    requests.length = 0;
    await api.resumeSession("session-xyz", "hello world");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain("session-xyz");
    expect(requests[0]!.body).toEqual({ prompt: "hello world" });
  });

  it("sends empty body when prompt is undefined explicitly", async () => {
    requests.length = 0;
    await api.resumeSession("session-def", undefined);
    expect(requests[0]!.body).toEqual({});
  });
});
