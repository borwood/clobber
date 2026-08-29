import { Database } from "bun:sqlite";
import { SCHEMA } from "./schema.ts";
import { migrateRoleVersions } from "./role-version-migration.ts";
import { migrateSessionLabel } from "./session-label-migration.ts";
import { migrateWorkspaceConfig } from "./workspace-config-migration.ts";
import { migrateSessionRuntime } from "./session-runtime-migration.ts";
import { migrateAgentQuestions } from "./agent-question-migration.ts";
import { migrateRoleEffort } from "./role-effort-migration.ts";
import { migrateRoleModel } from "./role-model-migration.ts";
import { migrateSessionWasLive } from "./session-was-live-migration.ts";
import { migrateSessionComposedPrompt } from "./session-composed-prompt-migration.ts";
import { migrateRoleAllowedToolsColumnDrop } from "./role-allowed-tools-column-drop-migration.ts";
import { migrateRoleContractVersion } from "./role-contract-version-migration.ts";
import { migrateRoleCommitPin } from "./role-commit-pin-migration.ts";
import { migrateWorkspaceTheme } from "./theme-migration.ts";
import { migrateSessionModelEffort } from "./session-model-effort-migration.ts";
import { migrateSessionDialOverrides } from "./session-dial-override-migration.ts";
import { migrateAuditRowProvenance } from "./audit-row-provenance-migration.ts";
import { migrateRoleCommitProvenance } from "./role-commit-provenance-migration.ts";
import { migrateRoleVersionPinDrop } from "./role-version-pin-drop-migration.ts";
import { migrateSessionOpLevel } from "./session-op-level-migration.ts";
import { migrateSessionTokenScope } from "./session-token-scope-migration.ts";
import { migrateNotificationLogicalKey } from "./notification-logical-key-migration.ts";
import { migrateNotificationDeliveryMode } from "./notification-delivery-mode-migration.ts";
import { migrateNotificationCategory } from "./notification-category-migration.ts";
import { migrateAgentSpawner } from "./agent-spawner-migration.ts";
import { migrateAgentWorktreeIdentity } from "./agent-worktree-identity-migration.ts";
import { migrateAgentMessageTokenAgentIds } from "./agent-message-token-agent-id-migration.ts";
import { migrateSessionContextTokens } from "./session-context-tokens-migration.ts";
import { backfillMissingSingletonAgents } from "./establish-singleton-agents.ts";

export function createDatabase(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  // contract_version must be added before migrateRoleVersions runs: that migration
  // constructs a RoleVersionStore whose prepared INSERT references contract_version,
  // so on an existing pre-#236 database the store's prepare throws unless the column
  // already exists. Fresh databases get it from SCHEMA; existing ones get it here.
  migrateRoleContractVersion(db);
  migrateRoleVersions(db);
  migrateSessionLabel(db);
  migrateSessionRuntime(db);
  migrateWorkspaceConfig(db);
  migrateAgentQuestions(db);
  migrateRoleEffort(db);
  // Must run before the column-drop rebuild below, which carries `model` through
  // its roles_new copy — mirrors migrateRoleEffort's placement.
  migrateRoleModel(db);
  migrateSessionWasLive(db);
  migrateSessionComposedPrompt(db);
  migrateRoleAllowedToolsColumnDrop(db);
  migrateRoleCommitPin(db);
  migrateWorkspaceTheme(db);
  migrateSessionModelEffort(db);
  migrateAuditRowProvenance(db);
  migrateRoleCommitProvenance(db);
  migrateRoleVersionPinDrop(db);
  migrateSessionOpLevel(db);
  migrateSessionDialOverrides(db);
  migrateSessionTokenScope(db);
  migrateNotificationLogicalKey(db);
  migrateNotificationDeliveryMode(db);
  migrateNotificationCategory(db);
  migrateAgentSpawner(db);
  migrateAgentWorktreeIdentity(db);
  migrateAgentMessageTokenAgentIds(db);
  migrateSessionContextTokens(db);
  // Must run last: depends on the agents table's final column shape (all
  // prior migrateAgent* ALTERs applied) and on roles/ceilings being seeded.
  backfillMissingSingletonAgents(db);
  return db;
}

export type { Database };
