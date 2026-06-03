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
        className="w-full px-3 py-1.5 mb-2 bg-surface border border-border rounded text-sm text-text-dim placeholder:text-text-faint focus:outline-none focus:border-border-strong disabled:opacity-50"
      />

      {totalSpawnable === 0 ? (
        <div className="p-3 text-xs text-text-subtle border border-border rounded">
          No roles available in this workspace. Set a ceiling first.
        </div>
      ) : visible.length === 0 ? (
        <div className="p-3 text-xs text-text-subtle border border-border rounded">
          No roles match "{query.trim()}".
        </div>
      ) : (
        <ul className="space-y-1 overflow-y-auto min-h-0 flex-1 pr-1">
          {visible.map(({ role, max_concurrent }) => {
            const isSelected = role.id === selectedRoleId;
            return (
              <li key={role.id}>
                <button
                  type="button"
                  onClick={() => onSelect(role.id)}
                  className={
                    "w-full text-left px-3 py-2 rounded border text-sm transition-colors " +
                    (isSelected
                      ? "bg-surface border-accent-strong"
                      : "border-border hover:border-border-strong hover:bg-surface")
                  }
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-text-dim">{role.name}</span>
                      {/* #385 / #491 — all roles are commit-pinned; surface commit provenance. */}
                      {role.current_commit !== undefined && (
                        <span
                          className="px-1 py-0.5 rounded bg-elevated text-provenance-text font-mono text-[10px]"
                          title={`${role.current_commit.branch} @ ${role.current_commit.sha}`}
                        >
                          {role.current_commit.sha.slice(0, 7)}
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-text-subtle font-mono">
                      ceiling {max_concurrent}
                    </span>
                  </div>
                  {role.description !== undefined && (
                    <div className="mt-0.5 text-xs text-text-subtle">{role.description}</div>
                  )}
                  <div className="mt-1 flex items-center gap-2 text-xs text-text-subtle">
                    {role.persistent && (
                      <span className="px-1.5 py-0.5 rounded bg-elevated text-text-muted">
                        persistent
                      </span>
                    )}
                    {role.permission_mode !== undefined && (
                      <span className="px-1.5 py-0.5 rounded bg-elevated text-text-muted font-mono">
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
