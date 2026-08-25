import type { ColumnType } from 'kysely';

export type SqliteBoolean = 0 | 1;
export type Nullable<T> = T | null;

export interface IdentityUsersTable {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  enabled: SqliteBoolean;
  created_at: string;
  updated_at: string;
}

export interface IdentityRolesTable {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface IdentityUserRolesTable {
  user_id: string;
  role_id: string;
  assigned_at: string;
  assigned_by: Nullable<string>;
}

export interface IdentitySessionsTable {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  revoked_at: Nullable<string>;
  created_at: string;
}

export interface WorkflowDefinitionsTable {
  id: string;
  name: string;
  description: string;
  draft_json: string;
  draft_version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowVersionsTable {
  id: string;
  workflow_id: string;
  version: number;
  definition_json: string;
  definition_digest: string;
  published_by: string;
  published_at: string;
}

export interface WorkflowRunsTable {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  initiated_by: string;
  input_json: string;
  status: string;
  current_step_instance_id: Nullable<string>;
  version: number;
  cancellation_requested: SqliteBoolean;
  idempotency_key: Nullable<string>;
  request_digest: Nullable<string>;
  correlation_id: Nullable<string>;
  metadata_json: string;
  failure_code: Nullable<string>;
  failure_message: Nullable<string>;
  created_at: string;
  started_at: Nullable<string>;
  completed_at: Nullable<string>;
}

export interface WorkflowStepInstancesTable {
  id: string;
  run_id: string;
  node_id: string;
  node_type: string;
  ordinal: number;
  status: string;
  input_json: Nullable<string>;
  output_json: Nullable<string>;
  observed_json: Nullable<string>;
  created_at: string;
  started_at: Nullable<string>;
  completed_at: Nullable<string>;
}

export interface WorkflowStepAttemptsTable {
  id: string;
  step_instance_id: string;
  attempt_number: number;
  status: string;
  input_json: Nullable<string>;
  output_json: Nullable<string>;
  error_json: Nullable<string>;
  dispatch_record_id: Nullable<string>;
  supervisor_execution_id: Nullable<string>;
  created_at: string;
  started_at: Nullable<string>;
  completed_at: Nullable<string>;
}

export interface WorkflowApprovalRequestsTable {
  id: string;
  run_id: string;
  step_instance_id: string;
  status: string;
  required_role_ids_json: string;
  matching_mode: string;
  minimum_approvals: number;
  initiator_may_approve: SqliteBoolean;
  approved_destination: Nullable<string>;
  rejected_destination: Nullable<string>;
  upstream_digest: string;
  created_at: string;
  resolved_at: Nullable<string>;
  cancelled_at: Nullable<string>;
}

export interface WorkflowApprovalDecisionsTable {
  id: string;
  approval_request_id: string;
  user_id: string;
  observed_role_ids_json: string;
  outcome: string;
  comment: Nullable<string>;
  upstream_digest: string;
  created_at: string;
}

export interface WorkflowDispatchRecordsTable {
  id: string;
  run_id: string;
  step_instance_id: string;
  step_attempt_id: string;
  idempotency_key: string;
  status: string;
  supervisor_execution_id: Nullable<string>;
  next_attempt_at: string;
  last_error: Nullable<string>;
  created_at: string;
  updated_at: string;
}

export interface WorkflowAuditEventsTable {
  id: string;
  actor_user_id: Nullable<string>;
  action: string;
  entity_type: string;
  entity_id: string;
  request_id: Nullable<string>;
  payload_json: string;
  created_at: string;
}

export interface SupervisorExecutionsTable {
  id: string;
  idempotency_key: string;
  agent_type: string;
  request_json: string;
  status: string;
  timeout_ms: number;
  output_json: Nullable<string>;
  error_code: Nullable<string>;
  error_message: Nullable<string>;
  created_at: string;
  started_at: Nullable<string>;
  finished_at: Nullable<string>;
}

export interface SupervisorExecutionEventsTable {
  execution_id: string;
  sequence: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export interface SupervisorIdempotencyKeysTable {
  idempotency_key: string;
  execution_id: string;
  created_at: string;
}

export interface SupervisorAgentsTable {
  id: string;
  name: string;
  system_prompt: string;
  cwd: string;
  tools_json: Nullable<string>;
  requested_model_provider: Nullable<string>;
  requested_model_id: Nullable<string>;
  thinking_level: Nullable<string>;
  created_at: string;
  updated_at: string;
  deleted_at: Nullable<string>;
}

export interface SupervisorAgentEventsTable {
  agent_id: string;
  run_id: Nullable<string>;
  sequence: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export interface SupervisorAgentRunsTable {
  id: string;
  agent_id: string;
  prompt: string;
  model_provider: Nullable<string>;
  model_id: Nullable<string>;
  thinking_level: Nullable<string>;
  cwd: string;
  status: string;
  error_code: Nullable<string>;
  error_message: Nullable<string>;
  created_at: string;
  started_at: Nullable<string>;
  completed_at: Nullable<string>;
}

export interface SupervisorAgentRunAttachmentsTable {
  run_id: string;
  position: number;
  name: string;
  mime_type: string;
  data: string;
  created_at: string;
}

export interface SupervisorAgentCommandReceiptsTable {
  id: string;
  idempotency_key: string;
  agent_id: string;
  command_type: string;
  request_digest: string;
  status: string;
  result_json: Nullable<string>;
  error_code: Nullable<string>;
  error_message: Nullable<string>;
  http_status: Nullable<number>;
  created_at: string;
  updated_at: string;
  completed_at: Nullable<string>;
}

export interface SupervisorProjectsTable {
  id: string;
  name: string;
  path: string;
  created_at: string;
  updated_at: string;
  last_used_at: string;
}

export interface IdentityDatabase {
  identity_users: IdentityUsersTable;
  identity_roles: IdentityRolesTable;
  identity_user_roles: IdentityUserRolesTable;
  identity_sessions: IdentitySessionsTable;
}

export interface WorkflowDatabase extends IdentityDatabase {
  workflow_definitions: WorkflowDefinitionsTable;
  workflow_versions: WorkflowVersionsTable;
  workflow_runs: WorkflowRunsTable;
  workflow_step_instances: WorkflowStepInstancesTable;
  workflow_step_attempts: WorkflowStepAttemptsTable;
  workflow_approval_requests: WorkflowApprovalRequestsTable;
  workflow_approval_decisions: WorkflowApprovalDecisionsTable;
  workflow_dispatch_records: WorkflowDispatchRecordsTable;
  workflow_audit_events: WorkflowAuditEventsTable;
}

export interface SupervisorDatabase {
  supervisor_executions: SupervisorExecutionsTable;
  supervisor_execution_events: SupervisorExecutionEventsTable;
  supervisor_idempotency_keys: SupervisorIdempotencyKeysTable;
  supervisor_agents: SupervisorAgentsTable;
  supervisor_agent_events: SupervisorAgentEventsTable;
  supervisor_agent_runs: SupervisorAgentRunsTable;
  supervisor_agent_run_attachments: SupervisorAgentRunAttachmentsTable;
  supervisor_agent_command_receipts: SupervisorAgentCommandReceiptsTable;
  supervisor_projects: SupervisorProjectsTable;
}

export interface MigrationDatabase extends WorkflowDatabase, SupervisorDatabase {}

export type DatabaseColumn<T> = ColumnType<T, T | undefined, T>;
