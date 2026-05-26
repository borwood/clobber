// Hand-rolled client routing for the three workspace routes (#6). Three routes
// don't justify a router dependency. Paths use a human-readable name slug
// (#243), resolved to a workspace in App via slugify(name).
//
//   /                    → no workspace selected (empty state)
//   /w/:slug             → workspace active, no session focused
//   /w/:slug/s/:sid      → workspace active + session focused (deep link)

export interface Route {
  readonly workspaceSlug: string | null;
  readonly sessionId: string | null;
}

export function parseLocation(pathname: string): Route {
  const segments = pathname.split("/").filter((s) => s.length > 0);
  if (segments[0] !== "w" || segments[1] === undefined) {
    return { workspaceSlug: null, sessionId: null };
  }
  const workspaceSlug = decodeURIComponent(segments[1]);
  if (segments[2] === "s" && segments[3] !== undefined) {
    return { workspaceSlug, sessionId: decodeURIComponent(segments[3]) };
  }
  return { workspaceSlug, sessionId: null };
}

export function buildPath(workspaceSlug: string | null, sessionId: string | null): string {
  if (workspaceSlug === null) return "/";
  const base = `/w/${encodeURIComponent(workspaceSlug)}`;
  if (sessionId === null) return base;
  return `${base}/s/${encodeURIComponent(sessionId)}`;
}
