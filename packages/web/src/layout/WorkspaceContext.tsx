import { createContext, useContext, type ReactNode } from "react";
import type {
  DeskCard,
  FinalReportEntry,
  Notification,
  OfficeCard,
  SessionSummary,
  WorkspaceRoleAssignment,
} from "../api.ts";

export interface WorkspaceContextValue {
  readonly activeWorkspaceId: string | null;
  readonly invalidWorkspace: boolean;
  readonly sessions: readonly SessionSummary[];
  readonly selectedSession: string | null;
  readonly assignments: readonly WorkspaceRoleAssignment[];
  readonly roleId: string | null;
  readonly setRoleId: (id: string) => void;
  readonly offices: readonly OfficeCard[];
  readonly desks: readonly DeskCard[];
  readonly reports: readonly FinalReportEntry[];
  readonly now: number;
  readonly wakingAgents: ReadonlySet<string>;
  readonly showSystem: boolean;
  readonly setShowSystem: (b: boolean) => void;
  readonly configOpen: boolean;
  readonly focusSession: (id: string) => void;
  readonly endSession: (id: string) => Promise<void>;
  readonly resumeSession: (id: string) => Promise<void>;
  readonly wakeAgent: (agentId: string, wakeProgram: string) => Promise<void>;
  readonly userNotifications: readonly Notification[];
}

const Ctx = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider(props: {
  readonly value: WorkspaceContextValue;
  readonly children: ReactNode;
}) {
  return <Ctx.Provider value={props.value}>{props.children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const v = useContext(Ctx);
  if (v === null) throw new Error("useWorkspace outside WorkspaceProvider");
  return v;
}
