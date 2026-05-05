import { useState } from "react";
import type { WorkspaceRoleAssignment } from "../api.ts";
import { filterRoleAssignments } from "./role-picker-filter.ts";

interface Props {
  readonly assignments: readonly WorkspaceRoleAssignment[];
  readonly selectedRoleId: string | null;
  readonly onSelect: (roleId: string) => void;
}

export function RolePicker({ assignments, selectedRoleId, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const visible = filterRoleAssignments(assignments, query);
  const totalSpawnable = assignments.filter((a) => a.max_concurrent > 0).length;

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={
          totalSpawnable === 0 ? "no spawnable roles" : `search ${totalSpawnable} role${totalSpawnable === 1 ? "" : "s"}…`
        }
        disabled={totalSpawnable === 0}
        className="w-full px-3 py-1.5 mb-2 bg-zinc-900 border border-zinc-800 rounded text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 disabled:opacity-50"
      />

      {totalSpawnable === 0 ? (
        <div className="p-3 text-xs text-zinc-500 border border-zinc-800 rounded">
          No roles available in this workspace. Set a ceiling first.
        </div>
      ) : visible.length === 0 ? (
        <div className="p-3 text-xs text-zinc-500 border border-zinc-800 rounded">
          No roles match "{query.trim()}".
        </div>
      ) : (
        <ul className="space-y-1 overflow-y-auto min-h-0 flex-1 pr-1">
          {visible.map(({ role, max_concurrent, current_version }) => {
            const isSelected = role.id === selectedRoleId;
            return (
              <li key={role.id}>
                <button
                  type="button"
                  onClick={() => onSelect(role.id)}
                  className={
                    "w-full text-left px-3 py-2 rounded border text-sm transition-colors " +
                    (isSelected
                      ? "bg-zinc-900 border-emerald-700"
                      : "border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900")
                  }
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-zinc-200">{role.name}</span>
                      {current_version !== undefined && (
                        <span
                          className="px-1 py-0.5 rounded bg-zinc-800 text-emerald-400 font-mono text-[10px]"
                          title={current_version.id}
                        >
                          v{current_version.version}
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-zinc-500 font-mono">
                      ceiling {max_concurrent}
                    </span>
                  </div>
                  {role.description !== undefined && (
                    <div className="mt-0.5 text-xs text-zinc-500">{role.description}</div>
                  )}
                  <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
                    {role.persistent && (
                      <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                        persistent
                      </span>
                    )}
                    {role.permission_mode !== undefined && (
                      <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">
                        {role.permission_mode}
                      </span>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
