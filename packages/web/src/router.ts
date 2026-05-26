// Hand-rolled client routing for the three workspace routes (#6). Three routes
// don't justify a router dependency.
//
//   /                       → no workspace selected (empty state)
//   /w/:workspaceId         → workspace active, no session focused
//   /w/:workspaceId/s/:sid  → workspace active + session focused (deep link)

export interface Route {
  readonly workspaceId: string | null;
  readonly sessionId: string | null;
}

export function parseLocation(pathname: string): Route {
  const segments = pathname.split("/").filter((s) => s.length > 0);
  if (segments[0] !== "w" || segments[1] === undefined) {
    return { workspaceId: null, sessionId: null };
  }
  const workspaceId = decodeURIComponent(segments[1]);
  if (segments[2] === "s" && segments[3] !== undefined) {
    return { workspaceId, sessionId: decodeURIComponent(segments[3]) };
  }
  return { workspaceId, sessionId: null };
}

export function buildPath(workspaceId: string | null, sessionId: string | null): string {
  if (workspaceId === null) return "/";
  const base = `/w/${encodeURIComponent(workspaceId)}`;
  if (sessionId === null) return base;
  return `${base}/s/${encodeURIComponent(sessionId)}`;
}
