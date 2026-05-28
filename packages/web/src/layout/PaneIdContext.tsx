import { createContext, useContext } from "react";

// Identifies the pane hosting the current view. Step 4 of open_session_tab
// routes to this pane when no empty/mailbox pane is available, so any view
// that dispatches open_session_tab needs the originating-pane id in scope.
const Ctx = createContext<string | null>(null);

export const PaneIdProvider = Ctx.Provider;

export function usePaneId(): string {
  const id = useContext(Ctx);
  if (id === null) throw new Error("usePaneId outside PaneIdProvider");
  return id;
}
