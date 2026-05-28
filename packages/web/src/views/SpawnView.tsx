import { RolePicker } from "../components/RolePicker.tsx";
import { SpawnPanel } from "../components/SpawnPanel.tsx";
import { useWorkspace } from "../layout/WorkspaceContext.tsx";

// Combined RolePicker + SpawnPanel (user clarification on #276). Height is
// inherited from the pane; the old `max-h-[60vh]` envelope handling is gone —
// pane-height IS the SpawnPanel envelope.
export function SpawnView() {
  const w = useWorkspace();
  if (w.activeWorkspaceId === null) {
    return (
      <p className="text-sm text-zinc-500 p-4">
        Create or select a workspace to spawn agents.
      </p>
    );
  }
  return (
    <>
      <div className="flex flex-col min-h-0 flex-1 p-4 pb-2 gap-2">
        <h2 className="text-sm uppercase tracking-wider text-zinc-500 shrink-0">role</h2>
        <RolePicker
          assignments={w.assignments}
          selectedRoleId={w.roleId}
          onSelect={w.setRoleId}
        />
      </div>
      <div className="border-t border-zinc-800 p-4 shrink-0 overflow-y-auto">
        <SpawnPanel
          workspaceId={w.activeWorkspaceId}
          roleId={w.roleId}
          onSpawned={(s) => w.focusSession(s.session_id)}
        />
      </div>
    </>
  );
}
