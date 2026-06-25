import { useState } from "react";
import { RolePicker } from "../components/RolePicker.tsx";
import { RoleEditorModal } from "../components/RoleEditorModal.tsx";
import { SpawnPanel } from "../components/SpawnPanel.tsx";
import { useWorkspace } from "../layout/WorkspaceContext.tsx";

// Combined RolePicker + SpawnPanel (user clarification on #276). The view is a
// bounded flex column: the role list takes the slack and scrolls; the spawn
// fields are capped (max-h) and shrink-and-scroll so a short pane never lets the
// fields crush the list off-screen (the old `shrink-0` bug). The per-role edit
// affordance opens the git-backed role authoring editor (#680).
export function SpawnView() {
  const w = useWorkspace();
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  if (w.activeWorkspaceId === null) {
    return (
      <p className="text-sm text-text-subtle p-4">
        Create or select a workspace to spawn agents.
      </p>
    );
  }
  const editing = w.assignments.find((a) => a.role.id === editingRoleId);
  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex flex-col min-h-0 flex-1 p-4 pb-2 gap-2">
        <h2 className="text-sm uppercase tracking-wider text-text-subtle shrink-0">role</h2>
        <RolePicker
          assignments={w.assignments}
          selectedRoleId={w.roleId}
          onSelect={w.setRoleId}
          onEdit={setEditingRoleId}
        />
      </div>
      <div className="border-t border-border p-4 shrink min-h-0 max-h-[55%] overflow-y-auto">
        <SpawnPanel
          workspaceId={w.activeWorkspaceId}
          roleId={w.roleId}
          wakePrograms={
            w.assignments.find((a) => a.role.id === w.roleId)?.wake_programs ?? []
          }
          onSpawned={(s) => w.focusSession(s.session_id)}
        />
      </div>
      {editing !== undefined && (
        <RoleEditorModal
          workspaceId={w.activeWorkspaceId}
          roleId={editing.role.id}
          roleName={editing.role.name}
          onClose={() => setEditingRoleId(null)}
          onSaved={() => {
            /* the workspace poll refreshes assignments within ~1s */
          }}
        />
      )}
    </div>
  );
}
