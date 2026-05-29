import { describe, it, expect } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { SequencedLayoutEvent } from "@clobber/shared";
import { createLayoutEventStore } from "../src/layout-event-store.ts";
import { registerLayoutEventRoutes } from "../src/routes/layout-events.ts";

const WS = "ws-a";

function buildApp(): {
  app: FastifyInstance;
  layoutEvents: ReturnType<typeof createLayoutEventStore>;
} {
  const layoutEvents = createLayoutEventStore();
  const app = Fastify({ logger: false });
  registerLayoutEventRoutes(app, { layoutEvents });
  return { app, layoutEvents };
}

async function poll(app: FastifyInstance, since: number): Promise<SequencedLayoutEvent[]> {
  const res = await app.inject({
    method: "GET",
    url: `/workspaces/${WS}/layout-events?since=${since}`,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as SequencedLayoutEvent[];
}

describe("GET /workspaces/:id/layout-events — server→web layout bridge (#326)", () => {
  it("returns an emitted swap_session_tab event past the client cursor", async () => {
    const { app, layoutEvents } = buildApp();

    expect(await poll(app, 0)).toEqual([]);

    layoutEvents.emit(WS, {
      type: "swap_session_tab",
      oldSessionId: "sess-old",
      newSessionId: "sess-new",
    });

    const after = await poll(app, 0);
    expect(after).toHaveLength(1);
    expect(after[0]!.seq).toBe(1);
    expect(after[0]!.event).toEqual({
      kind: "layout",
      action: {
        type: "swap_session_tab",
        oldSessionId: "sess-old",
        newSessionId: "sess-new",
      },
    });

    // A client that has already applied seq 1 polls with since=1 and gets nothing.
    expect(await poll(app, 1)).toEqual([]);

    await app.close();
  });

  it("delivers the same event to every client via its own cursor (multi-client)", async () => {
    const { app, layoutEvents } = buildApp();

    layoutEvents.emit(WS, {
      type: "swap_session_tab",
      oldSessionId: "a",
      newSessionId: "b",
    });

    const clientOne = await poll(app, 0);
    const clientTwo = await poll(app, 0);
    expect(clientOne).toHaveLength(1);
    expect(clientTwo).toHaveLength(1);
    expect(clientOne[0]!.event).toEqual(clientTwo[0]!.event);

    await app.close();
  });

  it("scopes events to their workspace", async () => {
    const { app, layoutEvents } = buildApp();
    layoutEvents.emit("other-ws", {
      type: "swap_session_tab",
      oldSessionId: "a",
      newSessionId: "b",
    });

    expect(await poll(app, 0)).toEqual([]);

    await app.close();
  });
});
