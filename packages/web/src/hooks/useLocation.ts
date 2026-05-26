import { useEffect, useState } from "react";

export interface Location {
  readonly pathname: string;
  readonly navigate: (path: string) => void;
}

// Tracks `location.pathname`, re-rendering on back/forward (popstate) and on
// programmatic `navigate` (pushState). Each window owns only its own URL — no
// shared client state across windows.
export function useLocation(): Location {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function navigate(path: string): void {
    if (path === window.location.pathname) return;
    window.history.pushState({}, "", path);
    setPathname(path);
  }

  return { pathname, navigate };
}
