import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  DEFAULT_SETTING_SOURCES,
  DEFAULT_ROLE_EDIT_FORBIDDEN_KEYS,
  DEFAULT_TRIGGER_OVERRIDES,
  DEFAULT_FINAL_REPORT_CALLBACK,
  DEFAULT_SPAWN_WORKTREE,
  DEFAULT_FILE_SIZE_POLICY,
  DEFAULT_MANAGER_SKILL_POLICY,
  DEFAULT_WORKSPACE_THEME,
  DEFAULT_WORKSPACE_PERMS_SCOPE,
  WorkspaceSchema,
  slugify,
  type CreateWorkspaceRequest,
  type CliScope,
  type FileSizePolicy,
  type FinalReportCallback,
  type ManagerSkillPolicy,
  type RoleEditPolicy,
  type SettingSource,
  type SpawnWorktree,
  type TriggerOverrides,
  type Workspace,
  type WorkspaceTheme,
  WorkspaceThemeSchema,
} from "@clobber/shared";

export interface WorkspaceConfigPatch {
  readonly setting_sources?: readonly SettingSource[];
  readonly role_edit_policy?: RoleEditPolicy;
  readonly trigger_overrides?: TriggerOverrides;
  readonly final_report_callback?: FinalReportCallback;
  readonly spawn_worktree?: SpawnWorktree;
  readonly file_size_policy?: FileSizePolicy;
  readonly manager_skill_policy?: ManagerSkillPolicy;
  readonly theme?: WorkspaceTheme;
  readonly perms_scope?: CliScope;
}

export interface WorkspaceStore {
  create(req: CreateWorkspaceRequest): Workspace;
  get(id: string): Workspace | null;
  // Matches on the derived slug, so it catches names that differ yet slugify to
  // the same path (e.g. "My Repo" vs "my repo"). Keeps `/w/:slug` 1:1.
  findBySlug(slug: string): Workspace | null;
  list(): Workspace[];
  updateConfig(id: string, config: WorkspaceConfigPatch): Workspace | null;
  delete(id: string): boolean;
}

interface Row {
  id: string;
  name: string;
  repo_path: string;
  setting_sources: string;
  role_edit_policy: string;
  trigger_overrides: string;
  final_report_callback: string;
  spawn_worktree: string;
  file_size_policy: string;
  manager_skill_policy: string;
  theme: string;
  perms_scope: string;
  created_at: number;
}

function rowToWorkspace(row: Row): Workspace {
  return WorkspaceSchema.parse({
    id: row.id,
    name: row.name,
    repo_path: row.repo_path,
    setting_sources: JSON.parse(row.setting_sources),
    role_edit_policy: JSON.parse(row.role_edit_policy),
    trigger_overrides: JSON.parse(row.trigger_overrides),
    final_report_callback: JSON.parse(row.final_report_callback),
    spawn_worktree: JSON.parse(row.spawn_worktree),
    file_size_policy: JSON.parse(row.file_size_policy),
    manager_skill_policy: JSON.parse(row.manager_skill_policy),
    theme: WorkspaceThemeSchema.parse(JSON.parse(row.theme)),
    perms_scope: JSON.parse(row.perms_scope),
    created_at: row.created_at,
  });
}

export function createWorkspaceStore(db: Database): WorkspaceStore {
  const insertStmt = db.prepare(
    `INSERT INTO workspaces
       (id, name, repo_path, setting_sources, role_edit_policy, trigger_overrides, final_report_callback, spawn_worktree, file_size_policy, manager_skill_policy, theme, perms_scope, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getStmt = db.prepare("SELECT * FROM workspaces WHERE id = ?");
  const listStmt = db.prepare(
    "SELECT * FROM workspaces ORDER BY created_at DESC, id DESC",
  );
  const deleteStmt = db.prepare("DELETE FROM workspaces WHERE id = ?");

  return {
    create(req) {
      const id = randomUUID();
      const created_at = Date.now();
      const sources = req.setting_sources ?? DEFAULT_SETTING_SOURCES;
      const policy: RoleEditPolicy = req.role_edit_policy ?? {
        forbidden_keys: [...DEFAULT_ROLE_EDIT_FORBIDDEN_KEYS],
      };
      const overrides: TriggerOverrides =
        req.trigger_overrides ?? { ...DEFAULT_TRIGGER_OVERRIDES };
      const callback: FinalReportCallback =
        req.final_report_callback ?? { ...DEFAULT_FINAL_REPORT_CALLBACK };
      const spawnWorktree: SpawnWorktree =
        req.spawn_worktree ?? { ...DEFAULT_SPAWN_WORKTREE };
      const fileSizePolicy: FileSizePolicy =
        req.file_size_policy ?? { ...DEFAULT_FILE_SIZE_POLICY };
      const skillPolicy: ManagerSkillPolicy = req.manager_skill_policy ?? {
        allow_self_grant: DEFAULT_MANAGER_SKILL_POLICY.allow_self_grant,
        allowed_skills: [...DEFAULT_MANAGER_SKILL_POLICY.allowed_skills],
      };
      const theme: WorkspaceTheme = req.theme ?? { ...DEFAULT_WORKSPACE_THEME };
      const permsScope: CliScope = req.perms_scope ?? { ...DEFAULT_WORKSPACE_PERMS_SCOPE };
      insertStmt.run(
        id,
        req.name,
        req.repo_path,
        JSON.stringify(sources),
        JSON.stringify(policy),
        JSON.stringify(overrides),
        JSON.stringify(callback),
        JSON.stringify(spawnWorktree),
        JSON.stringify(fileSizePolicy),
        JSON.stringify(skillPolicy),
        JSON.stringify(theme),
        JSON.stringify(permsScope),
        created_at,
      );
      return {
        id,
        name: req.name,
        repo_path: req.repo_path,
        setting_sources: [...sources],
        role_edit_policy: { forbidden_keys: [...policy.forbidden_keys] },
        trigger_overrides: overrides,
        final_report_callback: callback,
        spawn_worktree: spawnWorktree,
        file_size_policy: fileSizePolicy,
        manager_skill_policy: {
          allow_self_grant: skillPolicy.allow_self_grant,
          allowed_skills: [...skillPolicy.allowed_skills],
        },
        theme,
        perms_scope: { allow: [...permsScope.allow], deny: [...permsScope.deny] },
        created_at,
      };
    },

    get(id) {
      const row = getStmt.get(id) as Row | null;
      return row === null ? null : rowToWorkspace(row);
    },

    findBySlug(slug) {
      const rows = listStmt.all() as Row[];
      const row = rows.find((r) => slugify(r.name) === slug);
      return row === undefined ? null : rowToWorkspace(row);
    },

    list() {
      const rows = listStmt.all() as Row[];
      return rows.map(rowToWorkspace);
    },

    updateConfig(id, config) {
      const fragments: string[] = [];
      const values: string[] = [];
      if (config.setting_sources !== undefined) {
        fragments.push("setting_sources = ?");
        values.push(JSON.stringify(config.setting_sources));
      }
      if (config.role_edit_policy !== undefined) {
        fragments.push("role_edit_policy = ?");
        values.push(JSON.stringify(config.role_edit_policy));
      }
      if (config.trigger_overrides !== undefined) {
        fragments.push("trigger_overrides = ?");
        values.push(JSON.stringify(config.trigger_overrides));
      }
      if (config.final_report_callback !== undefined) {
        fragments.push("final_report_callback = ?");
        values.push(JSON.stringify(config.final_report_callback));
      }
      if (config.spawn_worktree !== undefined) {
        fragments.push("spawn_worktree = ?");
        values.push(JSON.stringify(config.spawn_worktree));
      }
      if (config.file_size_policy !== undefined) {
        fragments.push("file_size_policy = ?");
        values.push(JSON.stringify(config.file_size_policy));
      }
      if (config.manager_skill_policy !== undefined) {
        fragments.push("manager_skill_policy = ?");
        values.push(JSON.stringify(config.manager_skill_policy));
      }
      if (config.theme !== undefined) {
        fragments.push("theme = ?");
        values.push(JSON.stringify(config.theme));
      }
      if (config.perms_scope !== undefined) {
        fragments.push("perms_scope = ?");
        values.push(JSON.stringify(config.perms_scope));
      }
      if (fragments.length === 0) {
        const row = getStmt.get(id) as Row | null;
        return row === null ? null : rowToWorkspace(row);
      }
      const stmt = db.prepare(
        `UPDATE workspaces SET ${fragments.join(", ")} WHERE id = ?`,
      );
      const result = stmt.run(...values, id);
      if (result.changes === 0) return null;
      const row = getStmt.get(id) as Row | null;
      return row === null ? null : rowToWorkspace(row);
    },

    delete(id) {
      const result = deleteStmt.run(id);
      return result.changes > 0;
    },
  };
}
