export interface DriftStub {
  readonly apiBase: string;
  stop(): void;
}

// Synchronously starts a minimal HTTP server that returns a canned zero-drift
// response for POST /agent/roles/drift-sweep.  Used in test harnesses that
// need a valid apiBase so the http provider in composePromptModules succeeds.
//
// Returns the stub alongside the ephemeral apiBase to pass to createServer().
// Call stop() in teardown to close the server.
export function createDriftStub(): DriftStub {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return new Response("[Role drift] 0 roles in sync (stub).\n", {
        headers: { "content-type": "text/plain" },
      });
    },
  });
  return {
    apiBase: `http://127.0.0.1:${server.port}`,
    stop() {
      server.stop(true);
    },
  };
}

// Process-scoped singleton — started once at import time, freed at process
// exit.  Inline test suites that create their own server inline (no shared
// harness) import this constant to use as apiBase so compose succeeds after
// roles-drift-sweep is enabled by default (#401 step-2).
export const DRIFT_STUB_API_BASE: string = createDriftStub().apiBase;
