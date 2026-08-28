import { type Kysely, type Migration, type MigrationProvider, Migrator } from 'kysely';

import { initialMigration } from '../migrations/001_initial';
import { supervisorAgentsMigration } from '../migrations/002_supervisor_agents';
import { workflowRunsApiMigration } from '../migrations/003_workflow_runs_api';
import { supervisorAgentCommandReceiptsMigration } from '../migrations/004_supervisor_agent_command_receipts';
import { supervisorAgentNamesMigration } from '../migrations/005_supervisor_agent_names';
import { supervisorAgentRunsMigration } from '../migrations/006_supervisor_agent_runs';
import { supervisorAgentDefinitionRuntimeSplitMigration } from '../migrations/007_supervisor_agent_definition_runtime_split';
import { supervisorRunConfigurationMigration } from '../migrations/008_supervisor_run_configuration';
import { supervisorProjectsMigration } from '../migrations/009_supervisor_projects';
import { supervisorRunAdmissionAndProfilesMigration } from '../migrations/010_supervisor_run_admission_and_profiles';
import { supervisorCommandReceiptTypesMigration } from '../migrations/011_supervisor_command_receipt_types';
import { supervisorAgentRunAttachmentsMigration } from '../migrations/012_supervisor_agent_run_attachments';
import { workspaceCapabilitiesMigration } from '../migrations/013_workspace_capabilities';
import { piSessionOwnershipMigration } from '../migrations/014_pi_session_ownership';
import { supervisorAgentPromptSettingsMigration } from '../migrations/015_supervisor_agent_prompt_settings';
import type { MigrationDatabase } from './schema';

const migrations: Record<string, Migration> = {
  '001_initial': initialMigration,
  '002_supervisor_agents': supervisorAgentsMigration,
  '003_workflow_runs_api': workflowRunsApiMigration,
  '004_supervisor_agent_command_receipts': supervisorAgentCommandReceiptsMigration,
  '005_supervisor_agent_names': supervisorAgentNamesMigration,
  '006_supervisor_agent_runs': supervisorAgentRunsMigration,
  '007_supervisor_agent_definition_runtime_split': supervisorAgentDefinitionRuntimeSplitMigration,
  '008_supervisor_run_configuration': supervisorRunConfigurationMigration,
  '009_supervisor_projects': supervisorProjectsMigration,
  '010_supervisor_run_admission_and_profiles': supervisorRunAdmissionAndProfilesMigration,
  '011_supervisor_command_receipt_types': supervisorCommandReceiptTypesMigration,
  '012_supervisor_agent_run_attachments': supervisorAgentRunAttachmentsMigration,
  '013_workspace_capabilities': workspaceCapabilitiesMigration,
  '014_pi_session_ownership': piSessionOwnershipMigration,
  '015_supervisor_agent_prompt_settings': supervisorAgentPromptSettingsMigration,
};

const provider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};

export interface MigrationStatus {
  name: string;
  status: 'Executed' | 'NotExecuted';
  executedAt?: string;
}

function createMigrator(db: Kysely<MigrationDatabase>): Migrator {
  return new Migrator({ db, provider });
}

export async function migrateToLatest(db: Kysely<MigrationDatabase>) {
  const result = await createMigrator(db).migrateToLatest();
  if (result.error) {
    throw result.error;
  }

  return result.results;
}

export async function rollbackLastMigration(db: Kysely<MigrationDatabase>) {
  const result = await createMigrator(db).migrateDown();
  if (result.error) {
    throw result.error;
  }

  return result.results;
}

export async function getMigrationStatus(
  db: Kysely<MigrationDatabase>,
): Promise<MigrationStatus[]> {
  try {
    const statuses = await createMigrator(db).getMigrations();
    return statuses.map(({ name, executedAt }) => ({
      name,
      status: executedAt ? 'Executed' : 'NotExecuted',
      ...(executedAt ? { executedAt: executedAt.toISOString() } : {}),
    }));
  } catch (error) {
    if (isMissingMigrationTableError(error)) {
      return Object.keys(migrations).map((name) => ({ name, status: 'NotExecuted' }));
    }

    throw error;
  }
}

function isMissingMigrationTableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('no such table') &&
    error.message.includes('kysely_migration')
  );
}
